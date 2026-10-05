/**
 * Beacon Web Push client (v1.3.19) — one testable module for the whole
 * device pipeline: permission → service worker → subscription → server
 * registration, plus diagnostics and reconciliation.
 *
 * Modeled on TornScope's proven push.ts (read-only reference), with the
 * Beacon-specific differences that matter:
 *  - the service worker is resolved via an explicit `register("/sw.js")`
 *    (a concrete registration), never via `navigator.serviceWorker.ready`,
 *    which can wait indefinitely behind a waiting worker;
 *  - `updateViaCache: "none"` so the iPhone always revalidates the worker
 *    script regardless of HTTP cache state;
 *  - the VAPID public key is decoded with base64url tolerance, quote
 *    stripping and a hard 65-byte (uncompressed P-256) validation;
 *  - every failure is categorized for the settings UI; no raw DOMExceptions.
 *
 * Dependency-injected (PushBrowser/PushApi/FetchLike) so the whole pipeline
 * is unit-testable against stubs — the release gate runs these tests.
 */

/** Uncompressed EC P-256 VAPID public key = 0x04 || X || Y (65 bytes). */
export const VAPID_PUBLIC_KEY_BYTES = 65;

export interface PushSubscriptionLike {
  endpoint: string;
  toJSON(): { endpoint?: string; keys?: Record<string, string> };
}

export interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
}

export interface PushRegistrationLike {
  pushManager: PushManagerLike;
  active?: ServiceWorker | null;
  installing?: ServiceWorker | null;
  waiting?: ServiceWorker | null;
}

export interface PushBrowser {
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  /** Registers (or returns the existing) /sw.js and hands back its PushManager. */
  serviceWorker(): Promise<PushRegistrationLike>;
}

export interface PushApi {
  vapidPublicKey(): Promise<string | null>;
  registerSubscription(subscription: {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }): Promise<void>;
  /** Server-side subscription tails (endpointTail) for reconciliation. */
  listServerSubscriptions(): Promise<Array<{ endpointTail: string; enabled: boolean }>>;
}

export type PushFailureKind =
  | "server-unconfigured"
  | "permission-denied"
  | "invalid-key"
  | "sw-unavailable"
  | "unsupported"
  | "subscribe-failed"
  | "incomplete-subscription"
  | "registration-failed"
  | "unknown";

export type PushOutcome = { ok: true; endpoint: string } | ({ ok: false } & { kind: PushFailureKind });

export class PushKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushKeyError";
  }
}

/** base64url (or padded standard base64) → bytes, quote-tolerant. */
export function urlBase64ToUint8Array(input: string): Uint8Array<ArrayBuffer> {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new PushKeyError("empty key");
  const unquoted = trimmed.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  if (!/^[A-Za-z0-9+/\-_]*={0,2}$/.test(unquoted)) {
    throw new PushKeyError(`key contains characters outside the base64/base64url alphabet (length ${unquoted.length})`);
  }
  const normalized = unquoted.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (unquoted.length % 4)) % 4);
  let raw: string;
  try {
    raw = atob(normalized);
  } catch {
    throw new PushKeyError(`key is not valid base64/base64url (length ${unquoted.length})`);
  }
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/** VAPID public key → applicationServerKey, validated as 65-byte P-256. */
export function toApplicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
  const bytes = urlBase64ToUint8Array(publicKey);
  if (bytes.length !== VAPID_PUBLIC_KEY_BYTES) {
    throw new PushKeyError(`decoded public key is ${bytes.length} bytes, expected ${VAPID_PUBLIC_KEY_BYTES} (P-256 uncompressed)`);
  }
  return bytes;
}

export function categorizePushError(err: unknown): PushFailureKind {
  if (err instanceof PushKeyError) return "invalid-key";
  const name = (err as { name?: string } | null)?.name ?? "";
  if (name === "InvalidCharacterError") return "invalid-key";
  if (name === "NotAllowedError") return "permission-denied";
  if (name === "NotSupportedError" || name === "AbortError") return "unsupported";
  return "unknown";
}

/** The complete enable pipeline, categorized at every step. */
export async function enablePush(browser: PushBrowser, api: PushApi): Promise<PushOutcome> {
  let publicKey: string | null = null;
  try {
    publicKey = await api.vapidPublicKey();
  } catch {
    return { ok: false, kind: "registration-failed" };
  }
  if (!publicKey) return { ok: false, kind: "server-unconfigured" };

  // Permission first: iOS requires the request inside the user gesture.
  if (browser.permission() !== "granted") {
    let requested: NotificationPermission;
    try {
      requested = await browser.requestPermission();
    } catch {
      return { ok: false, kind: "permission-denied" };
    }
    if (requested !== "granted") return { ok: false, kind: "permission-denied" };
  }

  let key: Uint8Array<ArrayBuffer>;
  try {
    key = toApplicationServerKey(publicKey);
  } catch {
    return { ok: false, kind: "invalid-key" };
  }

  let registration: PushRegistrationLike;
  try {
    registration = await browser.serviceWorker();
  } catch {
    return { ok: false, kind: "sw-unavailable" };
  }

  let subscription: PushSubscriptionLike | null = null;
  try {
    subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
  } catch (err) {
    return { ok: false, kind: categorizePushError(err) === "invalid-key" ? "subscribe-failed" : categorizePushError(err) };
  }

  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    return { ok: false, kind: "incomplete-subscription" };
  }

  try {
    await api.registerSubscription({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  } catch {
    return { ok: false, kind: "registration-failed" };
  }
  return { ok: true, endpoint: json.endpoint };
}

/* ---- Fase 3/16: device diagnostics -------------------------------------- */

export interface DevicePushDiagnostics {
  secureContext: boolean;
  standalone: boolean;
  swSupported: boolean;
  pushManagerSupported: boolean;
  notificationSupported: boolean;
  permission: NotificationPermission | "unknown";
  registrationExists: boolean;
  installing: boolean;
  waiting: boolean;
  active: boolean;
  controller: boolean;
  activeScriptUrl: string | null;
  workerVersion: string | null;
  subscriptionPresent: boolean;
  subscriptionEndpointTail: string | null;
  /** Server knows this exact subscription (endpoint-tail match). */
  serverKnowsSubscription: boolean | null;
  /** Server has zero registered devices. */
  serverHasNoDevices: boolean | null;
}

/** Ask a worker for its build identity via postMessage (Fase 4). */
export function requestWorkerVersion(worker: ServiceWorker): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (result: string | null) => {
      // Close both ports: an open MessagePort keeps the event loop alive
      // (this hung the test runner and would keep worker threads alive).
      try { channel.port1.close(); channel.port2.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish(null), 2000);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      const data = event.data as { type?: string; version?: string } | null;
      finish(data?.type === "VERSION" && typeof data.version === "string" ? data.version : null);
    };
    try {
      worker.postMessage({ type: "GET_VERSION" }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/** Full device snapshot for Settings → Notifications (no secrets). */
export async function diagnoseDevice(
  browser: Pick<PushBrowser, "serviceWorker">,
  api: Pick<PushApi, "listServerSubscriptions">,
): Promise<DevicePushDiagnostics> {
  const diag: DevicePushDiagnostics = {
    secureContext: typeof window !== "undefined" ? window.isSecureContext : false,
    standalone: typeof window !== "undefined" ? (window.matchMedia?.("(display-mode: standalone)").matches ?? false) : false,
    swSupported: typeof navigator !== "undefined" && "serviceWorker" in navigator,
    pushManagerSupported: typeof window !== "undefined" && "PushManager" in window,
    notificationSupported: typeof Notification !== "undefined",
    permission: typeof Notification !== "undefined" ? Notification.permission : "unknown",
    registrationExists: false,
    installing: false,
    waiting: false,
    active: false,
    controller: Boolean(navigator.serviceWorker?.controller),
    activeScriptUrl: navigator.serviceWorker?.controller?.scriptURL ?? null,
    workerVersion: null,
    subscriptionPresent: false,
    subscriptionEndpointTail: null,
    serverKnowsSubscription: null,
    serverHasNoDevices: null,
  };
  // The injected browser decides whether diagnostics can run: with a real
  // browser this registers /sw.js; with DI stubs the environment flags above
  // may be sparse (node test runner has no navigator.serviceWorker).
  try {
    const registration = await browser.serviceWorker();
    diag.registrationExists = true;
    diag.installing = Boolean(registration.installing);
    diag.waiting = Boolean(registration.waiting);
    diag.active = Boolean(registration.active);
    if (registration.active) {
      diag.activeScriptUrl = registration.active.scriptURL;
      diag.workerVersion = await requestWorkerVersion(registration.active);
    }
    const subscription = await registration.pushManager.getSubscription();
    diag.subscriptionPresent = Boolean(subscription);
    if (subscription) diag.subscriptionEndpointTail = subscription.endpoint.slice(-12);
    const server = await api.listServerSubscriptions().catch(() => null);
    if (server) {
      diag.serverHasNoDevices = server.length === 0;
      diag.serverKnowsSubscription =
        subscription === null ? null : server.some((entry) => entry.endpointTail === subscription.endpoint.slice(-12));
    }
  } catch {
    // registration/subscribe surface stays honest: exists=false
  }
  return diag;
}

/** True when the device/browser pipeline cannot deliver push as-is. */
export function diagnosticsIndicateRepair(diagnostics: DevicePushDiagnostics): boolean {
  return (
    (diagnostics.registrationExists && !diagnostics.active) ||
    (diagnostics.subscriptionPresent && diagnostics.serverKnowsSubscription === false) ||
    (diagnostics.serverHasNoDevices === true && diagnostics.subscriptionPresent)
  );
}
