import { getEnvSafe } from "@/server/env";
import { sanitizeNotificationText } from "./types";
import type { PushSubscriptionRecord } from "./types";

/**
 * Web Push delivery (VAPID, standard protocol — no external SaaS).
 *
 * - Keys come from BEACON_VAPID_PUBLIC_KEY / BEACON_VAPID_PRIVATE_KEY /
 *   BEACON_VAPID_SUBJECT. Without them push is "not configured": the app
 *   runs normally, only remote delivery is disabled.
 * - 404/410 from the push service means the subscription is dead → it is
 *   pruned. Transient 5xx gets exactly one retry, then the failure is
 *   recorded on the subscription. No infinite retry loops.
 */

export interface PushConfigured {
  configured: boolean;
  publicKey: string | null;
  subject: string;
}

export function pushConfigured(): PushConfigured {
  const env = getEnvSafe();
  const publicKey = env.BEACON_VAPID_PUBLIC_KEY ?? null;
  const privateKey = env.BEACON_VAPID_PRIVATE_KEY ?? null;
  const configured = Boolean(publicKey && privateKey);
  return {
    configured,
    publicKey: configured ? publicKey : null,
    subject: env.BEACON_VAPID_SUBJECT ?? "mailto:beacon@localhost",
  };
}

export interface PushOutcome {
  endpoint: string;
  ok: boolean;
  /** 404/410 → the subscription is stale and must be pruned. */
  gone: boolean;
  /** Transient failure — a single retry already happened. */
  retryable: boolean;
  detail: string | null;
}

/** Dynamically imported so a missing/failed web-push never breaks boot. */
async function webPush(): Promise<typeof import("web-push")> {
  return (await import("web-push")) as typeof import("web-push");
}

type PushTransport = (
  subscription: PushSubscriptionRecord,
  payload: string,
  options: { vapidDetails: { subject: string; publicKey: string; privateKey: string }; TTL: number },
) => Promise<{ status: number }>;

let transportOverride: PushTransport | null = null;

/** Test seam: replaces the wire transport (never used in production). */
export function setPushTransportForTests(transport: PushTransport | null): void {
  transportOverride = transport;
}

export async function sendToSubscription(
  subscription: PushSubscriptionRecord,
  payload: {
    title: string;
    body: string;
    tag: string;
    url: string;
    severity: string;
  },
): Promise<PushOutcome> {
  const config = pushConfigured();
  if (!config.configured) {
    return { endpoint: subscription.endpoint, ok: false, gone: false, retryable: false, detail: "push not configured" };
  }
  // Defense in depth: the engine sanitizes at dispatch, but the wire layer
  // enforces it too — this is the boundary nearest the OS surface.
  const safePayload = JSON.stringify({
    title: sanitizeNotificationText(payload.title, 90),
    body: sanitizeNotificationText(payload.body, 220),
    tag: sanitizeNotificationText(payload.tag, 160),
    url: payload.url.startsWith("/") ? payload.url : "/",
    severity: payload.severity,
  });
  const options = {
    vapidDetails: { subject: config.subject, publicKey: config.publicKey!, privateKey: envPrivateKey() },
    TTL: 3600,
  };
  const attempt = async (): Promise<{ status: number } | null> => {
    try {
      if (transportOverride) {
        return await transportOverride(subscription, safePayload, options);
      }
      const push = await webPush();
      await push.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        safePayload,
        options,
      );
      return { status: 200 };
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode ?? 0;
      return { status };
    }
  };

  let result = await attempt();
  if (!result || (result.status >= 500 && result.status < 600)) {
    // Single retry after a short backoff — no loops.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    result = await attempt();
  }
  const status = result?.status ?? 0;
  if (status >= 200 && status < 300) {
    return { endpoint: subscription.endpoint, ok: true, gone: false, retryable: false, detail: null };
  }
  return {
    endpoint: subscription.endpoint,
    ok: false,
    gone: status === 404 || status === 410,
    retryable: status >= 500,
    detail: `push service responded ${status || "network error"}`,
  };
}

function envPrivateKey(): string {
  return getEnvSafe().BEACON_VAPID_PRIVATE_KEY ?? "";
}

/* ---- v1.3.22: test-push semantics (pure, testable) ----------------------- */

export interface TestPushClassification {
  ok: boolean;
  delivery: "pushed" | "in-app-only";
  reason: "no-subscribed-devices" | null;
  providerAccepted: boolean;
}

/** Fase 13 (v1.3.22): a Web Push test with zero registered devices is an
 *  explicit failure — in-app SSE delivery must never read as push success. */
export function classifyTestPush(enabledDevices: number): TestPushClassification {
  if (enabledDevices <= 0) {
    return { ok: false, delivery: "in-app-only", reason: "no-subscribed-devices", providerAccepted: false };
  }
  return { ok: true, delivery: "pushed", reason: null, providerAccepted: true };
}
