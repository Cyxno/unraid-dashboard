import test, { describe } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { createHash } from "node:crypto";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import {
  categorizePushError,
  diagnoseDevice,
  diagnosticsIndicateRepair,
  enablePush,
  requestWorkerVersion,
  toApplicationServerKey,
  urlBase64ToUint8Array,
  PushKeyError,
  type PushBrowser,
  type PushApi,
} from "../src/lib/push-client";

const KEY = "BDaFwwQk2cVT3jajMfCkGirCFQeEtdU9aqVEG-gDhIsM6s4By_5_oeudZOv4QQKQOa-g2ftU2eDWghQgn8Xfcdw";

/* ---- Fase 8/23: VAPID decode + key validation --------------------------- */

describe("VAPID decoding", () => {
  test("base64url public key decodes to 65 bytes (P-256 uncompressed)", () => {
    const bytes = toApplicationServerKey(KEY);
    assert.equal(bytes.length, 65);
    assert.equal(bytes[0], 0x04);
  });

  test("invalid key characters are categorized, not raw DOMExceptions", () => {
    assert.throws(() => urlBase64ToUint8Array("not*valid!"), PushKeyError);
    assert.equal(categorizePushError(new PushKeyError("x")), "invalid-key");
    assert.equal(categorizePushError({ name: "InvalidCharacterError" }), "invalid-key");
  });

  test("wrong decoded length is rejected (not 65 bytes)", () => {
    // 32-byte key: decodes, but is not an uncompressed P-256 point.
    const short = Buffer.from("a".repeat(43), "base64url").toString("base64url");
    assert.throws(() => toApplicationServerKey(short), PushKeyError);
  });
});

/* ---- Fase 20/23: enable pipeline with injected browser ------------------ */

function makeBrowser(overrides: {
  permission?: NotificationPermission;
  requestResult?: NotificationPermission;
  registration?: Record<string, unknown>;
  subscription?: unknown;
  subscribeError?: Error;
} = {}): PushBrowser & { registrations: number } {
  const state = { registrations: 0 };
  const registration = overrides.registration ?? {
    pushManager: {
      getSubscription: async () => (overrides.subscription ?? null),
      subscribe: async () => {
        if (overrides.subscribeError) throw overrides.subscribeError;
        return {
          endpoint: "https://push.example/abc",
          toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } }),
          // v1.3.24 pipeline expects the POST to succeed via the api stub.
        };
      },
    },
  };
  return {
    get registrations() { return state.registrations; },
    permission: () => overrides.permission ?? "default",
    requestPermission: async () => overrides.requestResult ?? "granted",
    serviceWorker: async () => {
      state.registrations += 1;
      return registration as never;
    },
  } as never;
}

function makeApi(overrides: { publicKey?: string | null; registerFails?: boolean; server?: Array<{ endpointTail: string; fingerprint?: string; enabled: boolean }> } = {}): PushApi & { registered: unknown[] } {
  const registered: unknown[] = [];
  const serverEntries: Array<{ endpointTail: string; fingerprint?: string; enabled: boolean }> = overrides.server
    ? overrides.server.map((entry) => ({ ...entry }))
    : [];
  return {
    registered,
    vapidPublicKey: async () => ("publicKey" in overrides ? (overrides.publicKey ?? null) : KEY),
    registerSubscription: async (subscription) => {
      if (overrides.registerFails) throw new Error("no");
      registered.push(subscription);
      // v1.3.24 pipeline: mirror the server's fingerprint bookkeeping.
      serverEntries.push({
        endpointTail: subscription.endpoint.slice(-12),
        fingerprint: createHash("sha256").update(subscription.endpoint).digest("hex").slice(0, 16),
        enabled: true,
      });
    },
    listServerSubscriptions: async () => serverEntries.map((entry) => ({ ...entry })),
  };
}

describe("Enable pipeline (push-client)", () => {
  test("server-unconfigured", async () => {
    const outcome = await enablePush(makeBrowser(), makeApi({ publicKey: null }));
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { kind?: string }).kind, "server-unconfigured");
  });

  test("permission denied without prompting twice", async () => {
    const browser = makeBrowser({ permission: "denied", requestResult: "denied" });
    const outcome = await enablePush(browser, makeApi());
    assert.equal(outcome.ok, false);
  });

  test("permission granted → subscribe → server registration (happy path)", async () => {
    const browser = makeBrowser();
    const api = makeApi();
    const outcome = await enablePush(browser, api);
    if (!outcome.ok) console.log("V1317-HAPPY-FAIL:", outcome.kind, JSON.stringify(outcome.trace));
    assert.equal(outcome.ok, true);
    assert.equal((outcome as { endpoint?: string }).endpoint, "https://push.example/abc");
    assert.equal(api.registered.length, 1);
  });

  test("uses a CONCRETE registration (register) — never navigator.serviceWorker.ready", async () => {
    const browser = makeBrowser();
    await enablePush(browser, makeApi());
    assert.equal(browser.registrations, 1, "must call register('/sw.js') exactly once");
  });

  test("reuses an existing browser subscription (no blind resubscribe)", async () => {
    const existing = {
      endpoint: "https://push.example/existing",
      toJSON: () => ({ endpoint: "https://push.example/existing", keys: { p256dh: "k", auth: "a" } }),
    };
    const browser = makeBrowser({ subscription: existing });
    const api = makeApi();
    const outcome = await enablePush(browser, api);
    if (!outcome.ok) console.log("V1317-REUSE-FAIL:", outcome.kind, JSON.stringify(outcome.trace));
    assert.equal(outcome.ok, true);
    assert.equal(api.registered[0] && (api.registered[0] as { endpoint: string }).endpoint, "https://push.example/existing");
  });

  test("subscribe failure categorized (NotAllowedError → permission-denied)", async () => {
    const outcome = await enablePush(makeBrowser({ subscribeError: Object.assign(new Error("x"), { name: "NotAllowedError" }) }), makeApi());
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { kind: string }).kind, "permission-denied");
  });

  test("server registration failure categorized", async () => {
    const outcome = await enablePush(makeBrowser(), makeApi({ registerFails: true }));
    assert.equal((outcome as { kind: string }).kind, "registration-failed");
  });

  test("incomplete subscription categorized", async () => {
    const browser = makeBrowser({
      subscription: {
        endpoint: "https://push.example/x",
        toJSON: () => ({ endpoint: "https://push.example/x" }),
      },
    });
    const outcome = await enablePush(browser, makeApi());
    assert.equal((outcome as { kind: string }).kind, "incomplete-subscription");
  });
});

/* ---- Fase 3/16/23: diagnostics + waiting worker ------------------------- */

describe("Device diagnostics", () => {
  test("waiting worker + browser subscription without server knowledge → repair indicated", async () => {
    const diag = await diagnoseDevice(
      {
        serviceWorker: async () => ({
          pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/abc", toJSON: () => ({ endpoint: "https://push.example/abc" }) }) },
          active: { scriptURL: "/sw.js", postMessage: () => {} },
          waiting: { scriptURL: "/sw.js" },
          installing: null,
        }) as never,
      },
      { listServerSubscriptions: async () => [{ endpointTail: "other12345678", enabled: true }] },
    );
    assert.equal(diag.waiting, true);
    assert.equal(diag.subscriptionPresent, true);
    assert.equal(diag.serverKnowsSubscription, false);
    assert.equal(diagnosticsIndicateRepair(diag), true);
  });

  test("healthy device: active worker, subscription known server-side → no repair", async () => {
    const diag = await diagnoseDevice(
      {
        serviceWorker: async () => ({
          pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/tailmatches12", toJSON: () => ({}) }) },
          active: {
            scriptURL: "/sw.js",
            postMessage: (message: unknown, transfer?: unknown) => {
              const port = (transfer as MessagePort[])?.[0];
              port?.postMessage({ type: "VERSION", version: "v1.3.17+tailfix" });
            },
          },
          waiting: null,
          installing: null,
        }) as never,
      },
      { listServerSubscriptions: async () => [{ endpointTail: "ailmatches12", enabled: true }] },
    );
    assert.equal(diagnosticsIndicateRepair(diag), false);
  });

  test("worker version handshake resolves via postMessage", async () => {
    const sent: unknown[] = [];
    const fakeWorker = {
      // Echo the version over the transferred MessagePort — exactly what the
      // real service worker does in its GET_VERSION handler.
      postMessage: (message: unknown, transfer?: unknown) => {
        sent.push({ message, transfer });
        const port = (transfer as MessagePort[])?.[0];
        port?.postMessage({ type: "VERSION", version: "v1.3.19+abc1234" });
      },
    } as never as ServiceWorker;
    const version = await requestWorkerVersion(fakeWorker);
    assert.equal(version, "v1.3.19+abc1234");
    assert.equal(sent.length, 1);
  });

  test("worker handshake timeout returns null (never hangs the UI)", async () => {
    const fakeWorker = { postMessage: () => {} } as never as ServiceWorker;
    const version = await requestWorkerVersion(fakeWorker);
    assert.equal(version, null);
  });
});

