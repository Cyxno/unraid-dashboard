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
  /** Server-side subscriptions for reconciliation (fingerprint preferred). */
  listServerSubscriptions(): Promise<Array<{ endpointTail: string; fingerprint?: string; enabled: boolean }>>;
  /** v1.3.22: remove server registrations by endpoint fingerprint. */
  deleteServerSubscription?(fingerprints: string[]): Promise<number>;
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

export interface EnableOptions {
  /** v1.3.21 (Fase A6/A20/A21): unsubscribe + resubscribe instead of reusing
   *  an existing subscription. iOS can silently deactivate subscriptions that
   *  belonged to an old, still-dropping worker — reusing those keeps push
   *  broken on background/closed. Repair flows should set this after a
   *  diagnosis, never on every load. */
  recreate?: boolean;
}

/** Wait (bounded) until the registration has an ACTIVE worker; asks any
 *  waiting worker to skip waiting first (push-capable worker policy). */
export async function ensureActiveWorker(
  registration: PushRegistrationLike & {
    update?: () => Promise<void>;
    active?: ServiceWorker | null;
    waiting?: ServiceWorker | null;
  },
  timeoutMs = 8000,
): Promise<{ active: ServiceWorker | null; workerVersion: string | null }> {
  const deadline = Date.now() + timeoutMs;
  // Ask a waiting worker to take over — it contains the current push handler.
  try {
    registration.waiting?.postMessage("SKIP_WAITING");
  } catch {}
  let active: ServiceWorker | null = registration.active ?? null;
  while (!active && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      active = reg?.active ?? null;
    } catch {
      active = registration.active ?? null;
    }
  }
  let workerVersion: string | null = null;
  if (active) workerVersion = await requestWorkerVersion(active);
  return { active, workerVersion };
}

/** The complete enable pipeline, categorized at every step. */
export async function enablePush(
  browser: PushBrowser,
  api: PushApi,
  options: EnableOptions = {},
): Promise<PushOutcome> {
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
    const existing = await registration.pushManager.getSubscription();
    if (existing && options.recreate) {
      // Stale iOS subscription (old worker silently dropped pushes): a fresh
      // subscription re-arms the platform delivery path.
      await (existing as { unsubscribe?: () => Promise<boolean> }).unsubscribe?.();
      subscription = null;
    }
    subscription =
      existing && !options.recreate
        ? existing
        : await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
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

export interface PushWorkerTelemetry {
  pushReceived: number;
  lastPushAt: string | null;
  lastShowResult: "shown" | "error" | null;
  lastShowErrorName: string | null;
}

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
  /** v1.3.21: SW-side push telemetry (A10/A11). */
  telemetry: PushWorkerTelemetry | null;
  subscriptionPresent: boolean;
  /** v1.3.22: SHA-256-truncated endpoint fingerprint (privacy-safe). */
  subscriptionFingerprint: string | null;
  /** v1.3.22: number of enabled server-registered devices. */
  serverDevices: number | null;
  /** v1.3.22: canonical state classification. */
  state: CanonicalPushState;
  subscriptionEndpointTail: string | null;
  /** Server knows this exact subscription (endpoint-tail match). */
  serverKnowsSubscription: boolean | null;
  /** Server has zero registered devices. */
  serverHasNoDevices: boolean | null;
}

/** Ask a worker for its build identity via postMessage (Fase 4). */
export interface WorkerInfo {
  version: string | null;
  telemetry: PushWorkerTelemetry | null;
}

/** Fase A10/A11: version + push telemetry from the worker (no payloads). */
export function requestWorkerInfo(worker: ServiceWorker): Promise<WorkerInfo> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (result: WorkerInfo) => {
      // Close both ports: an open MessagePort keeps the event loop alive
      // (this hung the test runner and would keep worker threads alive).
      try { channel.port1.close(); channel.port2.close(); } catch {}
      resolve(result);
    };
    const timer = setTimeout(() => finish({ version: null, telemetry: null }), 2000);
    channel.port1.onmessage = (event: MessageEvent) => {
      clearTimeout(timer);
      const data = event.data as
        | { type?: string; version?: string; telemetry?: PushWorkerTelemetry }
        | null;
      finish({
        version: data?.type === "VERSION" && typeof data.version === "string" ? data.version : null,
        telemetry: data?.telemetry ?? null,
      });
    };
    try {
      worker.postMessage({ type: "GET_VERSION" }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      finish({ version: null, telemetry: null });
    }
  });
}

/** Back-compat helper: just the worker version string. */
export function requestWorkerVersion(worker: ServiceWorker): Promise<string | null> {
  return requestWorkerInfo(worker).then((info) => info.version);
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
    controller: Boolean(typeof navigator !== "undefined" && navigator.serviceWorker?.controller),
    activeScriptUrl: navigator.serviceWorker?.controller?.scriptURL ?? null,
    workerVersion: null,
    telemetry: null,
    subscriptionPresent: false,
    subscriptionFingerprint: null,
    serverDevices: null,
    state: "SW_NOT_ACTIVE",
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
      const info = await requestWorkerInfo(registration.active);
      diag.workerVersion = info.version;
      diag.telemetry = info.telemetry;
    }
    const subscription = await registration.pushManager.getSubscription();
    diag.subscriptionPresent = Boolean(subscription);
    if (subscription) {
      diag.subscriptionEndpointTail = subscription.endpoint.slice(-12);
      diag.subscriptionFingerprint = await endpointFingerprint(subscription.endpoint);
    }
    const server = await api.listServerSubscriptions().catch(() => null);
    if (server) {
      diag.serverDevices = server.length;
      diag.serverHasNoDevices = server.length === 0;
      diag.serverKnowsSubscription =
        subscription === null
          ? null
          : server.some((entry) =>
              // v1.3.22 servers expose fingerprints; v1.3.21 servers only the tail.
              "fingerprint" in entry && entry.fingerprint
                ? entry.fingerprint === diag.subscriptionFingerprint
                : entry.endpointTail === subscription.endpoint.slice(-12),
            );
    }
  } catch {
    // registration/subscribe surface stays honest: exists=false
  }
  diag.state = resolveCanonicalPushState({
    permission: diag.permission === "unknown" ? "unknown" : diag.permission,
    subscriptionPresent: diag.subscriptionPresent,
    subscriptionFingerprint: diag.subscriptionFingerprint,
    serverKnowsSubscription: diag.serverKnowsSubscription,
    serverDevices: diag.serverDevices,
    swActive: diag.active,
    workerVersion: diag.workerVersion,
  } satisfies PushStateEvidence);
  return diag;
}

/** Convenience: canonical state straight from a fresh diagnosis. */
export async function resolvePushState(
  browser: Pick<PushBrowser, "serviceWorker">,
  api: Pick<PushApi, "listServerSubscriptions">,
): Promise<{ state: CanonicalPushState; diagnostics: DevicePushDiagnostics }> {
  const diagnostics = await diagnoseDevice(browser, api);
  return { state: diagnostics.state, diagnostics };
}

/** True when the device/browser pipeline cannot deliver push as-is. */
export function diagnosticsIndicateRepair(diagnostics: DevicePushDiagnostics): boolean {
  return (
    (diagnostics.registrationExists && !diagnostics.active) ||
    (diagnostics.subscriptionPresent && diagnostics.serverKnowsSubscription === false) ||
    (diagnostics.serverHasNoDevices === true && diagnostics.subscriptionPresent)
  );
}

/* ---- v1.3.22: canonical Web Push state model ----------------------------- */

/** Privacy-safe endpoint fingerprint: SHA-256 truncated to 16 hex chars.
 *  Client (WebCrypto) and server (node:crypto) compute the same value so
 *  browser↔server reconciliation never exposes the raw endpoint. */
export async function endpointFingerprint(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Resolve the concrete Beacon /sw.js registration for every push lifecycle
 *  action (Fase 19): enable, repair, disable and diagnostics all use THIS
 *  resolver — never navigator.serviceWorker.ready, which can wait
 *  indefinitely behind a waiting worker. */
export async function getBeaconPushRegistration(): Promise<PushRegistrationLike> {
  const registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  return registration as unknown as PushRegistrationLike;
}

export type CanonicalPushState =
  | "UNSUPPORTED"
  | "PERMISSION_REQUIRED"
  | "PERMISSION_DENIED"
  | "PERMISSION_GRANTED_NO_SUBSCRIPTION"
  | "SUBSCRIBED_LOCAL_ONLY"
  | "SUBSCRIBED_SERVER_REGISTERED"
  | "SUBSCRIPTION_MISMATCH"
  | "SW_NOT_ACTIVE"
  | "PUSH_READY";

export interface PushStateEvidence {
  permission: NotificationPermission | "unknown";
  subscriptionPresent: boolean;
  subscriptionFingerprint: string | null;
  serverKnowsSubscription: boolean | null;
  serverDevices: number | null;
  swActive: boolean;
  workerVersion: string | null;
}

/**
 * Fase 1 (v1.3.22): one canonical classification. Permission alone is NEVER
 * "push enabled" — the enabled state requires BOTH a browser subscription
 * AND a server-side registration that knows the same fingerprint.
 */
export function resolveCanonicalPushState(evidence: PushStateEvidence): CanonicalPushState {
  if (!evidence.swActive) return "SW_NOT_ACTIVE";
  if (evidence.permission === "denied") return "PERMISSION_DENIED";
  if (evidence.permission !== "granted") return "PERMISSION_REQUIRED";
  if (!evidence.subscriptionPresent) return "PERMISSION_GRANTED_NO_SUBSCRIPTION";
  if (evidence.serverKnowsSubscription === true) return "PUSH_READY";
  if (evidence.serverKnowsSubscription === false) return "SUBSCRIPTION_MISMATCH";
  return "SUBSCRIBED_LOCAL_ONLY";
}

/** Fase 4/19 (v1.3.22): disable contract — unsubscribe the local
 *  subscription AND remove the server registration, using the SAME
 *  concrete registration resolver as enable/repair. Browser permission
 *  always remains granted (a webapp cannot revoke it). */
export async function disablePush(
  browser: PushBrowser,
  api: PushApi & { deleteServerSubscription?: (fingerprints: string[]) => Promise<number> },
  fingerprintHint?: string | null,
): Promise<{ localRemoved: boolean; serverRemoved: number; permissionStillGranted: boolean }> {
  let localRemoved = false;
  const fingerprints: string[] = [];
  let permission = browser.permission();
  try {
    const registration = await browser.serviceWorker();
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      const json = subscription.toJSON();
      if (json.endpoint) fingerprints.push(await endpointFingerprint(json.endpoint));
      await (subscription as { unsubscribe?: () => Promise<boolean> }).unsubscribe?.();
      localRemoved = true;
    } else if (fingerprintHint) {
      fingerprints.push(fingerprintHint);
    }
    permission = browser.permission();
  } catch {
    // Local unsubscribe is best-effort; the server entry is still removed.
  }
  let serverRemoved = 0;
  if (fingerprints.length > 0 && api.deleteServerSubscription) {
    serverRemoved = await api.deleteServerSubscription(fingerprints).catch(() => 0);
  }
  return { localRemoved, serverRemoved, permissionStillGranted: permission === "granted" };
}
