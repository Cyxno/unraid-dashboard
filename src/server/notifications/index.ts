import { publishEvent } from "@/server/events/sampler";
import { evaluateEvents } from "./engine";
import { loadState, loadStateFromDisk, saveNow, scheduleSave } from "./store";
import { sendToSubscription, pushConfigured } from "./push";
import { collectEvents as collectEventsFromSources } from "./sources";
import type { DeliveryStatus, NotificationRecord, RawEvent } from "./types";

/**
 * Notification orchestrator: evaluates sources on an interval, runs the
 * dedupe/preference engine, persists state, and delivers through:
 *  1. Web Push (VAPID) to every enabled subscription
 *  2. the SSE bus ("notification" event) for currently open clients
 *
 * Self-starting and idempotent: the interval lives on globalThis and is
 * started by the first API route that touches notifications. Evaluation
 * is transition-based and cheap (all sources serve cached data).
 */

const EVALUATE_INTERVAL_MS = 60_000;

const globalStore = globalThis as unknown as {
  __notificationLoop?: ReturnType<typeof setInterval>;
  __notificationBusy?: boolean;
};

type EventSource = () => Promise<RawEvent[]>;
let eventSourceOverride: EventSource | null = null;

/** Test seam: replaces the event sources (never used in production). */
export function setEventSourceForTests(source: EventSource | null): void {
  eventSourceOverride = source;
}

function pushRecord(
  state: ReturnType<typeof loadState>,
  record: Omit<NotificationRecord, "id">,
): NotificationRecord {
  state.lastId += 1;
  const full: NotificationRecord = { id: state.lastId, ...record };
  state.history.push(full);
  if (state.history.length > 250) state.history.splice(0, state.history.length - 250);
  return full;
}

/** Publishes to the SSE bus so open clients can toast/notify locally. */
function broadcastToClients(record: NotificationRecord): void {
  try {
    publishEvent({
      event: "notification",
      data: {
        id: record.id,
        severity: record.severity,
        title: record.title,
        body: record.body,
        url: record.url,
        kind: record.kind,
      },
    } as Parameters<typeof publishEvent>[0]);
  } catch {
    // The SSE bus may not be started — in-app delivery is best-effort.
  }
}

async function dispatchPush(
  notifications: Array<{ record: NotificationRecord; title: string; body: string; url: string; fingerprint: string; severity: string }>,
): Promise<void> {
  const state = loadState();
  const config = pushConfigured();
  // In-app delivery (SSE broadcast) already happened for open clients; the
  // push outcome refines the record. Without VAPID/subscribers the record
  // stays an honest "in-app" with the reason, never a silent loss.
  if (!config.configured) {
    for (const notification of notifications) {
      notification.record.detail = "push not configured (VAPID keys missing) — delivered in-app only";
    }
    return;
  }
  const subscriptions = state.subscriptions.filter((entry) => entry.enabled);
  for (const notification of notifications) {
    if (subscriptions.length === 0) {
      notification.record.detail = "no subscribed devices — delivered in-app only";
      continue;
    }
    const outcomes = await Promise.all(
      subscriptions.map((subscription) =>
        sendToSubscription(subscription, {
          title: notification.title,
          body: notification.body,
          tag: notification.fingerprint,
          url: notification.url,
          severity: notification.severity,
        }),
      ),
    );
    let anySuccess = false;
    for (const outcome of outcomes) {
      const subscription = state.subscriptions.find((entry) => entry.endpoint === outcome.endpoint);
      if (!subscription) continue;
      if (outcome.ok) {
        anySuccess = true;
        subscription.lastSuccessAt = new Date().toISOString();
      } else {
        subscription.lastFailureAt = new Date().toISOString();
        if (outcome.gone) {
          // 404/410: the push service says this subscription is dead.
          state.subscriptions = state.subscriptions.filter((entry) => entry.endpoint !== outcome.endpoint);
        }
      }
    }
    notification.record.delivery = anySuccess ? "pushed" : "failed";
    notification.record.detail = anySuccess ? null : (outcomes.find((outcome) => !outcome.ok)?.detail ?? "delivery failed");
  }
}

async function runCycle(): Promise<void> {
  if (globalStore.__notificationBusy) return;
  globalStore.__notificationBusy = true;
  try {
    const state = await loadStateFromDisk();

    // First-run / upgrade protection (anti-spam): before the baseline is
    // taken, current conditions are ingested into the active set SILENTLY.
    // Only future TRANSITIONS dispatch — activating notifications on a
    // server that already has three unhealthy containers must never flood
    // devices with pre-existing problems.
    const baseline = state.baselinedAt === null;
    const rawEvents: RawEvent[] = eventSourceOverride ? await eventSourceOverride() : await collectEventsFromSources();
    const decision = evaluateEvents(baseline ? [] : rawEvents, state.active, state.preferences, Date.now());

    if (baseline) {
      const baselineDecision = evaluateEvents(rawEvents, state.active, state.preferences, Date.now());
      for (const upsert of baselineDecision.activeUpserts) {
        state.active[upsert.fingerprint] = upsert;
      }
      state.baselinedAt = Date.now();
      await saveNow().catch(() => scheduleSave(1000));
      return;
    }

    // Merge active-set upserts; drop resolved fingerprints.
    for (const upsert of decision.activeUpserts) {
      if (decision.resolved.includes(upsert.fingerprint)) {
        delete state.active[upsert.fingerprint];
      } else {
        state.active[upsert.fingerprint] = upsert;
      }
    }

    // Record history entries (id-assigned) and collect push candidates.
    const notifications: Array<{ record: NotificationRecord; title: string; body: string; url: string; fingerprint: string; severity: string }> = [];
    for (const entry of decision.records) {
      const record = pushRecord(state, entry);
      const dispatched = decision.dispatch.find(
        (candidate) => candidate.fingerprint === entry.fingerprint && candidate.title === entry.title,
      );
      if (dispatched) {
        notifications.push({
          record,
          title: dispatched.title,
          body: dispatched.body,
          url: dispatched.url,
          fingerprint: dispatched.fingerprint,
          severity: dispatched.severity,
        });
      }
    }

    // Mark notified fingerprints so recovery events only fire for
    // conditions that were actually notified.
    for (const notification of notifications) {
      const active = state.active[notification.fingerprint];
      if (active) active.notifiedAt = Date.now();
    }

    await dispatchPush(notifications.map((notification) => ({ ...notification, record: notification.record })));
    for (const notification of notifications) {
      const record = state.history.find((entry) => entry.id === notification.record.id) ?? notification.record;
      broadcastToClients(record);
    }

    await saveNow().catch(() => scheduleSave(1000));
  } catch {
    // The notification system must never take the app down.
  } finally {
    globalStore.__notificationBusy = false;
  }
}

export function startNotificationLoop(): void {
  if (globalStore.__notificationLoop) return;
  // First cycle after a short settle, then on the fixed interval.
  globalStore.__notificationLoop = setInterval(() => void runCycle(), EVALUATE_INTERVAL_MS);
  setTimeout(() => void runCycle(), 15_000).unref?.();
}

/** Manual "Send test notification": pushes a user-triggered test event. */
export async function sendTestNotification(): Promise<{ delivered: DeliveryStatus; detail: string | null }> {
  const state = await loadStateFromDisk();
  const record = pushRecord(state, {
    fingerprint: `test:${Date.now()}`,
    category: "services",
    severity: "info",
    title: "Test notification",
    body: "If you can read this on your device, Beacon notifications work.",
    source: "beacon",
    url: "/settings",
    occurredAt: new Date().toISOString(),
    kind: "test",
    delivery: "in-app",
    detail: null,
  });
  broadcastToClients(record);
  const notifications = [
    { record, title: record.title, body: record.body, url: record.url, fingerprint: record.fingerprint, severity: record.severity },
  ];
  await dispatchPush(notifications);
  const outcome = notifications[0]!.record.delivery;
  await saveNow().catch(() => scheduleSave(500));
  return { delivered: outcome, detail: notifications[0]!.record.detail };
}

export async function evaluateNow(): Promise<void> {
  await runCycle();
}

// Exported for tests.
export { runCycle as runEvaluationCycle };
