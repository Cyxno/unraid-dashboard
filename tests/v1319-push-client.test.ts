import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import process from "node:process";

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

function makeApi(overrides: { publicKey?: string | null; registerFails?: boolean; server?: Array<{ endpointTail: string; enabled: boolean }> } = {}): PushApi & { registered: unknown[] } {
  const registered: unknown[] = [];
  return {
    registered,
    vapidPublicKey: async () => ("publicKey" in overrides ? (overrides.publicKey ?? null) : KEY),
    registerSubscription: async (subscription) => {
      if (overrides.registerFails) throw new Error("no");
      registered.push(subscription);
    },
    listServerSubscriptions: async () => overrides.server ?? [],
  };
}

describe("Enable pipeline (push-client)", () => {
  test("server-unconfigured", async () => {
    const outcome = await enablePush(makeBrowser(), makeApi({ publicKey: null }));
    assert.deepEqual(outcome, { ok: false, kind: "server-unconfigured" });
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
    assert.deepEqual(outcome, { ok: true, endpoint: "https://push.example/abc" });
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
          pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/x/tailmatches1", toJSON: () => ({}) }) },
          active: { scriptURL: "/sw.js", postMessage: () => {} },
          waiting: null,
          installing: null,
        }) as never,
      },
      { listServerSubscriptions: async () => [{ endpointTail: "tailmatches1", enabled: true }] },
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

/* ---- Fase 13/15/23: real service worker behavior in a VM sandbox -------- */

interface Sandbox {
  listeners: Record<string, ((event: unknown) => void) | undefined>;
  waited: Promise<unknown>[];
  notifications: Array<{ title: string; options: Record<string, unknown> }>;
  opened: string[];
  focused: string[];
  navigate: string[];
}

function loadSandbox(): Sandbox {
  const sandbox: Sandbox = { listeners: {}, notifications: [], opened: [], focused: [], navigate: [], waited: [] };
  const self = {
    location: { origin: "https://beacon.example" },
    registration: {
      showNotification: (title: string, options: Record<string, unknown>) => {
        sandbox.notifications.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      matchAll: async () => [
        { url: "https://beacon.example/settings", focus: async () => sandbox.focused.push("settings"), navigate: async (u: string) => sandbox.navigate.push(u) },
      ],
      openWindow: async (u: string) => sandbox.opened.push(u),
      claim: async () => {},
    },
    caches: { keys: async () => [], open: async () => ({ add: async () => {}, match: async () => null, put: async () => {}, delete: async () => {} }), delete: async () => {} },
    skipWaiting: async () => {},
    navigationPreload: { disable: async () => {} },
    addEventListener: (type: string, handler: (event: unknown) => void) => {
      sandbox.listeners[type] = handler;
    },
  };
  const context = vm.createContext({ self, ...self, navigator: {}, URL });
  const source = fs.readFileSync(path.join(ROOT, "public", "sw.js"), "utf8").replace(/__GIT_SHA__/g, "abc1234");
  vm.runInContext(source, context);
  return sandbox;
}

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

function pushEvent(payload: unknown) {
  return {
    data: payload === undefined ? undefined : { json: () => (typeof payload === "string" ? JSON.parse(payload) : payload), text: () => String(payload) },
    waitUntil: (p: Promise<unknown>) => void p,
  };
}

describe("Service worker push handler (real sw.js in a VM sandbox)", () => {
  interface Sandbox {
    listeners: Record<string, ((event: unknown) => void) | undefined>;
    notifications: Array<{ title: string; options: Record<string, unknown> }>;
    opened: string[];
    focused: string[];
    navigate: string[];
    waited: Promise<unknown>[];
  }

  function loadSandbox(): Sandbox {
    const sandbox: Sandbox = { listeners: {}, notifications: [], opened: [], focused: [], navigate: [], waited: [] };
    const self = {
      location: { origin: "https://beacon.example" },
      registration: {
        showNotification: (title: string, options: Record<string, unknown>) => {
          sandbox.notifications.push({ title, options });
          return Promise.resolve();
        },
      },
      clients: {
        matchAll: async () => [
          { url: "https://beacon.example/", focus: async () => sandbox.focused.push("root"), navigate: async (u: string) => sandbox.navigate.push(u) },
        ],
        openWindow: async (u: string) => sandbox.opened.push(u),
        claim: async () => {},
      },
      caches: {
        keys: async () => [],
        open: async () => ({ add: async () => {}, match: async () => null, put: async () => {}, delete: async () => {} }),
        delete: async () => {},
      },
      skipWaiting: async () => {},
      navigationPreload: { disable: async () => {} },
      addEventListener: (type: string, handler: (event: unknown) => void) => {
        sandbox.listeners[type] = handler;
      },
    };
    const context = vm.createContext({ self, ...self, navigator: {}, URL });
    const source = fs.readFileSync(path.join(ROOT, "public", "sw.js"), "utf8").replace(/__GIT_SHA__/g, "abc1234");
    vm.runInContext(source, context);
    return sandbox;
  }

  function pushEvent(payload: unknown, waited: Promise<unknown>[]) {
    const event = {
      data:
        payload === undefined
          ? undefined
          : {
              json: () => (typeof payload === "string" ? JSON.parse(payload) : payload),
              text: () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
            },
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    };
    return event;
  }

  function pushEventRaw(raw: string, waited: Promise<unknown>[]) {
    return {
      data: { json: () => { throw new Error("bad json"); }, text: () => raw },
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    };
  }

  function clickEvent(data: { url?: string } | undefined, waited: Promise<unknown>[]) {
    return {
      notification: { close: () => {}, data },
      waitUntil: (p: Promise<unknown>) => waited.push(p),
    };
  }

  test("valid payload → showNotification with exact fields", async () => {
    const sw = loadSandbox();
    const waited: Promise<unknown>[] = [];
    await sw.listeners.push?.(pushEvent({ title: "Disk warning", body: "Below 5%", tag: "disk:1", url: "/network" }, waited));
    await Promise.all(waited);
    assert.equal(sw.notifications.length, 1);
    assert.equal(sw.notifications[0]!.title, "Disk warning");
    assert.equal(sw.notifications[0]!.options.tag, "disk:1");
    assert.equal((sw.notifications[0]!.options.data as { url: string }).url, "/network");
    assert.equal(sw.notifications[0]!.options.silent, false);
  });

  test("malformed JSON → generic fallback notification, never a silent drop", async () => {
    const sw = loadSandbox();
    const waited: Promise<unknown>[] = [];
    await sw.listeners.push?.(pushEventRaw("not-json-at-all", waited));
    await Promise.all(waited);
    assert.equal(sw.notifications.length, 1);
    assert.equal(sw.notifications[0]!.title, "Beacon");
  });

  test("empty push event → fallback notification", async () => {
    const sw = loadSandbox();
    const waited: Promise<unknown>[] = [];
    await sw.listeners.push?.(pushEvent(undefined, waited));
    await Promise.all(waited);
    assert.equal(sw.notifications.length, 1);
  });

  test("payload without title → fallback notification (was silently dropped before v1.3.19)", async () => {
    const sw = loadSandbox();
    const waited: Promise<unknown>[] = [];
    await sw.listeners.push?.(pushEvent({ body: "no title here" }, waited));
    await Promise.all(waited);
    assert.equal(sw.notifications.length, 1);
    assert.equal(sw.notifications[0]!.title, "Beacon");
  });

  test("notificationclick focuses the existing Beacon window and navigates", async () => {
    const sw = loadSandbox();
    const waited: Promise<unknown>[] = [];
    await sw.listeners.push?.(pushEvent({ title: "t", url: "/network" }, waited));
    await Promise.all(waited);
    await sw.listeners.notificationclick?.(clickEvent({ url: "/network" }, waited));
    await Promise.all(waited);
    assert.deepEqual(sw.focused, ["root"]);
    assert.deepEqual(sw.navigate, ["/network"]);
    assert.deepEqual(sw.opened, []);
  });

  test("closed app → notificationclick opens a new window at the deep link", async () => {
    const sandbox: Sandbox = { listeners: {}, notifications: [], opened: [], focused: [], navigate: [], waited: [] };
    const self = {
      location: { origin: "https://beacon.example" },
      registration: { showNotification: async (t: string, o: Record<string, unknown>) => { sandbox.notifications.push({ title: t, options: o }); } },
      clients: { matchAll: async () => [], openWindow: async (u: string) => sandbox.opened.push(u), claim: async () => {} },
      caches: { keys: async () => [], open: async () => ({ add: async () => {} }), delete: async () => {} },
      skipWaiting: async () => {},
      navigationPreload: { disable: async () => {} },
      addEventListener: (type: string, handler: (event: unknown) => void) => { sandbox.listeners[type] = handler; },
    };
    vm.runInContext(
      fs.readFileSync(path.join(ROOT, "public", "sw.js"), "utf8").replace(/__GIT_SHA__/g, "abc1234"),
      vm.createContext({ self, ...self, navigator: {}, URL }),
    );
    const waited: Promise<unknown>[] = [];
    await sandbox.listeners.push?.(pushEvent({ title: "t", url: "/docker" }, waited));
    await Promise.all(waited);
    await sandbox.listeners.notificationclick?.(clickEvent({ url: "/docker" }, waited));
    await Promise.all(waited);
    assert.deepEqual(sandbox.opened, ["https://beacon.example/docker"]);
  });
});
