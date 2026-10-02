import type {
  ActiveEvent,
  EventSeverity,
  NotificationPreferences,
  NotificationRecord,
  RawEvent,
} from "./types";
import { sanitizeNotificationText } from "./types";

/**
 * The notification decision engine: transition-based, dedupe-first.
 *
 * - A fingerprint that is not in the active set is a NEW condition →
 *   candidate notification (subject to preferences) and it joins the set.
 * - A fingerprint already active is the SAME condition → never re-notified.
 * - A previously notified fingerprint that disappears → optional resolved
 *   notification (only if it was actually notified and preferences allow).
 * - Burst control: per evaluation, after the first 3 notifications the
 *   remaining warning/info events are grouped into one digest. Critical
 *   events are never grouped — critical incidents must not be hidden.
 */

export const MAX_INDIVIDUAL_PER_CYCLE = 3;

export interface EngineDecision {
  /** Notifications to dispatch now (already sanitized). */
  dispatch: Array<{
    fingerprint: string;
    severity: EventSeverity;
    category: RawEvent["category"];
    title: string;
    body: string;
    url: string;
    kind: NotificationRecord["kind"];
  }>;
  /** New history records (dispatched, skipped, resolved, digest). */
  records: Array<Omit<NotificationRecord, "id">>;
  /** Fingerprint → updated active entry (caller merges into state). */
  activeUpserts: Array<ActiveEvent>;
  /** Fingerprints resolved this cycle. */
  resolved: string[];
}

function allowed(
  event: RawEvent,
  prefs: NotificationPreferences,
): { allowed: boolean; detail?: string } {
  if (!prefs.master) return { allowed: false, detail: "notifications disabled" };
  if (!prefs.severities[event.severity]) {
    return { allowed: false, detail: `${event.severity} severity disabled` };
  }
  if (!prefs.categories[event.category]) {
    return { allowed: false, detail: `category ${event.category} disabled` };
  }
  return { allowed: true };
}

export function sanitizeEvent(event: RawEvent): RawEvent {
  return {
    ...event,
    title: sanitizeNotificationText(event.title, 90),
    body: sanitizeNotificationText(event.body, 220),
    source: sanitizeNotificationText(event.source, 40),
  };
}

export function evaluateEvents(
  rawEvents: RawEvent[],
  previousActive: Record<string, ActiveEvent>,
  prefs: NotificationPreferences,
  now: number,
): EngineDecision {
  const decision: EngineDecision = {
    dispatch: [],
    records: [],
    activeUpserts: [],
    resolved: [],
  };

  // 1. Active set refresh + resolution detection.
  const seen = new Set<string>();
  for (const raw of rawEvents) {
    const event = sanitizeEvent(raw);
    seen.add(event.fingerprint);
    const previous = previousActive[event.fingerprint];
    decision.activeUpserts.push({
      fingerprint: event.fingerprint,
      severity: event.severity,
      category: event.category,
      title: event.title,
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
      notifiedAt: previous?.notifiedAt ?? null,
    });
  }
  for (const [fingerprint, entry] of Object.entries(previousActive)) {
    if (!seen.has(fingerprint)) {
      decision.resolved.push(fingerprint);
      decision.activeUpserts.push({ ...entry, lastSeenAt: now });
    }
  }

  // 2. New conditions → dispatch candidates.
  const newEvents = rawEvents
    .map((event) => sanitizeEvent(event))
    .filter((event) => previousActive[event.fingerprint] === undefined);

  let individual = 0;
  const grouped: RawEvent[] = [];
  for (const event of newEvents) {
    const gate = allowed(event, prefs);
    if (!gate.allowed) {
      decision.records.push({
        fingerprint: event.fingerprint,
        category: event.category,
        severity: event.severity,
        title: event.title,
        body: event.body,
        source: event.source,
        url: event.url,
        occurredAt: new Date(now).toISOString(),
        kind: "event",
        delivery: "skipped-preference",
        detail: gate.detail ?? null,
      });
      continue;
    }
    if (individual < MAX_INDIVIDUAL_PER_CYCLE || event.severity === "critical") {
      individual += 1;
      decision.dispatch.push({
        fingerprint: event.fingerprint,
        severity: event.severity,
        category: event.category,
        title: event.title,
        body: event.body,
        url: event.url,
        kind: "event",
      });
      decision.records.push({
        fingerprint: event.fingerprint,
        category: event.category,
        severity: event.severity,
        title: event.title,
        body: event.body,
        source: event.source,
        url: event.url,
        occurredAt: new Date(now).toISOString(),
        kind: "event",
        delivery: "in-app",
        detail: null,
      });
    } else {
      grouped.push(event);
    }
  }

  if (grouped.length > 0) {
    const criticalCount = grouped.filter((event) => event.severity === "critical").length;
    decision.dispatch.push({
      fingerprint: `digest:${now}`,
      severity: criticalCount > 0 ? "critical" : "warning",
      category: grouped[0]!.category,
      title: `${grouped.length} new conditions detected`,
      body: grouped
        .slice(0, 5)
        .map((event) => event.title)
        .join(" · "),
      url: "/",
      kind: "digest",
    });
    decision.records.push({
      fingerprint: `digest:${now}`,
      category: grouped[0]!.category,
      severity: criticalCount > 0 ? "critical" : "warning",
      title: `${grouped.length} new conditions detected`,
      body: grouped.map((event) => event.title).join(" · "),
      source: grouped[0]!.source,
      url: "/",
      occurredAt: new Date(now).toISOString(),
      kind: "digest",
      delivery: "in-app",
      detail: null,
    });
  }

  // 3. Resolved events → optional recovery notification.
  for (const fingerprint of decision.resolved) {
    const entry = previousActive[fingerprint];
    if (!entry?.notifiedAt) continue; // never notified → nothing to resolve
    const gate =
      prefs.master && prefs.categories.resolved
        ? { allowed: true }
        : { allowed: false, detail: "resolved notifications disabled" };
    decision.records.push({
      fingerprint,
      category: "resolved",
      severity: "info",
      title: `Resolved: ${entry.title}`,
      body: "The condition is no longer present.",
      source: entry.category,
      url: "/",
      occurredAt: new Date(now).toISOString(),
      kind: "resolved",
      delivery: gate.allowed ? "in-app" : "skipped-preference",
      detail: gate.allowed ? null : (gate.detail ?? null),
    });
    if (gate.allowed) {
      decision.dispatch.push({
        fingerprint: `resolved:${fingerprint}:${now}`,
        severity: "info",
        category: "resolved",
        title: `Resolved: ${entry.title}`,
        body: "The condition is no longer present.",
        url: "/",
        kind: "resolved",
      });
    }
  }

  return decision;
}

/** Whether a raw event may be delivered, for the dispatcher's records. */
export function deliveryAllowedFor(event: { severity: EventSeverity; category: RawEvent["category"] }, prefs: NotificationPreferences): boolean {
  return allowed(
    { severity: event.severity, category: event.category } as RawEvent,
    prefs,
  ).allowed;
}
