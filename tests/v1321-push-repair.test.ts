import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  diagnoseDevice,
  enablePush,
  ensureActiveWorker,
  type PushBrowser,
  type PushApi,
} from "../src/lib/push-client";

const KEY = "BDaFwwQk2cVT3jajMfCkGirCFQeEtdU9aqVEG-gDhIsM6s4By_5_oeudZOv4QQKQOa-g2ftU2eDWghQgn8Xfcdw";

function sub(endpoint: string) {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: "k", auth: "a" } }),
    unsubscribe: async () => true,
  };
}

function browserWith(opts: {
  existingEndpoint?: string | null;
  unsubscribed?: string[];
  waiting?: object | null;
  activePostMessage?: (message: unknown, transfer?: unknown) => void;
}) {
  const unsubscribed: string[] = [];
  const registration: Record<string, unknown> = {
    pushManager: {
      getSubscription: async () =>
        opts.existingEndpoint ? sub(opts.existingEndpoint) : null,
      subscribe: async () => sub("https://push.example/fresh"),
    },
    active: { scriptURL: "/sw.js", postMessage: opts.activePostMessage ?? (() => {}) },
    waiting: opts.waiting ?? null,
    installing: null,
    update: async () => {},
  };
  const browser = {
    permission: () => "granted",
    requestPermission: async () => "granted",
    serviceWorker: async () => registration as never,
  } as unknown as PushBrowser & { unsubscribed: string[] };
  (browser as unknown as { unsubscribed: string[] }).unsubscribed = unsubscribed;
  // expose the registration so the test can read unsubscribe behavior
  (browser as unknown as { __registration: unknown }).__registration = registration;
  (browser as unknown as { __unsubscribed: string[] }).__unsubscribed = unsubscribed;
  return browser as PushBrowser & {
    registrations: number;
    unsubscribed: string[];
    __registration: { pushManager: { getSubscription: () => Promise<unknown>; subscribe: (o: unknown) => Promise<unknown> } };
    __unsubscribed: string[];
  };
}

function api() {
  const registered: Array<{ endpoint: string }> = [];
  return {
    registered,
    vapidPublicKey: async () => KEY,
    registerSubscription: async (s: { endpoint: string }) => { registered.push(s); },
    listServerSubscriptions: async () => [] as Array<{ endpointTail: string; enabled: boolean }>,
  } as PushApi & { registered: Array<{ endpoint: string }> };
}

describe("v1.3.21 repair flow — recreate replaces stale subscriptions", () => {
  test("enable without recreate REUSES an existing subscription", async () => {
    const browser = browserWith({ existingEndpoint: "https://push.example/old" });
    let subscribeCalls = 0;
    const reg = (browser as unknown as { __registration: { pushManager: { subscribe: (o: unknown) => Promise<unknown> } } }).__registration;
    reg.pushManager.subscribe = async () => { subscribeCalls += 1; return sub("https://push.example/new"); };
    const outcome = await enablePush(browser, api() as never);
    assert.equal(outcome.ok, true);
    assert.equal(subscribeCalls, 0, "must not resubscribe when reusing");
    const unsub = (browser as unknown as { __unsubscribed: string[] }).__unsubscribed;
    assert.deepEqual(unsub, []);
  });

  test("enable with recreate=true unsubscribes the stale subscription and creates a fresh one", async () => {
    const browser = browserWith({ existingEndpoint: "https://push.example/stale" });
    const reg = (browser as unknown as { __registration: { pushManager: { getSubscription: () => Promise<unknown> } } }).__registration;
    let unsubCalls = 0;
    reg.pushManager.getSubscription = async () => ({
      endpoint: "https://push.example/stale",
      toJSON: () => ({ endpoint: "https://push.example/stale", keys: { p256dh: "k", auth: "a" } }),
      unsubscribe: async () => { unsubCalls += 1; return true; },
    });
    const apiClient = api();
    const outcome = await enablePush(browser, apiClient as never, { recreate: true });
    assert.equal(outcome.ok, true);
    assert.equal(unsubCalls, 1, "stale subscription must be unsubscribed");
    assert.equal((apiClient.registered[0] as { endpoint: string }).endpoint, "https://push.example/fresh");
  });

  test("enable with recreate=false never unsubscribes (default load path)", async () => {
    const browser = browserWith({ existingEndpoint: "https://push.example/keep" });
    const reg = (browser as unknown as { __registration: { pushManager: { getSubscription: () => Promise<unknown> } } }).__registration;
    let unsubCalls = 0;
    reg.pushManager.getSubscription = async () => ({
      endpoint: "https://push.example/keep",
      toJSON: () => ({ endpoint: "https://push.example/keep", keys: { p256dh: "k", auth: "a" } }),
      unsubscribe: async () => { unsubCalls += 1; return true; },
    });
    await enablePush(browser, api() as never, { recreate: false });
    assert.equal(unsubCalls, 0);
  });
});

describe("v1.3.21 worker-state policy — repair ensures the ACTIVE worker is current", () => {
  test("ensureActiveWorker asks a waiting worker to SKIP_WAITING and waits for activation", async () => {
    let skipAsked = false;
    const activeWorker = { scriptURL: "/sw.js", postMessage: () => {} };
    const registration = {
      pushManager: { getSubscription: async () => null },
      active: null as ServiceWorker | null,
      waiting: { postMessage: (msg: string) => { if (msg === "SKIP_WAITING") skipAsked = true; } },
      installing: null,
    };
    // Simulate activation after 600ms.
    setTimeout(() => { registration.active = activeWorker as unknown as ServiceWorker; }, 600);
    const result = await ensureActiveWorker(registration as never, 5000);
    assert.equal(skipAsked, true);
    assert.ok(result.active, "worker must be active after ensure");
  });

  test("worker telemetry is carried through diagnoseDevice", async () => {
    const diag = await diagnoseDevice(
      {
        serviceWorker: async () => ({
          pushManager: { getSubscription: async () => null },
          active: {
            scriptURL: "/sw.js",
            postMessage: (_message: unknown, transfer?: unknown) => {
              const port = (transfer as MessagePort[])?.[0];
              port?.postMessage({
                type: "VERSION",
                version: "v1.3.21+abc1234",
                telemetry: { pushReceived: 3, lastPushAt: "2026-10-06T00:00:00Z", lastShowResult: "shown", lastShowErrorName: null },
              });
            },
          },
          waiting: null,
          installing: null,
        }) as never,
      },
      { listServerSubscriptions: async () => [] } as never,
    );
    assert.equal(diag.workerVersion, "v1.3.21+abc1234");
    assert.deepEqual(diag.telemetry, {
      pushReceived: 3,
      lastPushAt: "2026-10-06T00:00:00Z",
      lastShowResult: "shown",
      lastShowErrorName: null,
    });
  });
});

describe("v1.3.21 release-gate: provenance + policy assertions", () => {
  const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

  test("version sources aligned (helper == package == changelog)", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const helper = fs.readFileSync(path.join(ROOT, "helper", "server.js"), "utf8");
    const changelog = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "generated", "changelog.json"), "utf8"));
    const sw = fs.readFileSync(path.join(ROOT, "public", "sw.js"), "utf8");
    const helperMatch = helper.match(/HELPER_VERSION = "([^"]+)"/);
    assert.ok(helperMatch);
    assert.equal(helperMatch[1], pkg.version, "helper HELPER_VERSION must equal package.json");
    assert.equal(changelog.latestVersion, `v${pkg.version}`, "changelog latest must track package.json");
    assert.ok(
      sw.includes(`const VERSION = "v${pkg.version}";`),
      "service worker version must track package.json",
    );
  });

  test("immutable semver policy still enforced in the publish workflow", () => {
    const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "docker-publish.yml"), "utf8");
    assert.match(workflow, /if \[ "\$CH" = "release" \]; then/);
    assert.match(workflow, /semver tag \$V not touched \(immutable\)/);
  });

  test("repair-mode button uses the recreate path (recreate: mode === 'repair')", () => {
    const section = fs.readFileSync(path.join(ROOT, "src", "components", "settings", "notifications-section.tsx"), "utf8");
    assert.match(section, /\{ recreate: mode === "repair" \}/);
    assert.match(section, /Repair this device/);
    assert.match(section, /void enableNotifications\("repair"\)/);
  });

  test("sw telemetry captures showNotification failures without payload", () => {
    const sw = fs.readFileSync(path.join(ROOT, "public", "sw.js"), "utf8");
    assert.match(sw, /PUSH_TELEMETRY\.pushReceived \+= 1/);
    assert.match(sw, /lastShowErrorName = \(error && error\.name\)/);
    assert.doesNotMatch(sw, /PUSH_TELEMETRY\.(payload|body|endpoint)/);
  });

  test("no secrets in push telemetry or diagnostics", () => {
    const client = fs.readFileSync(path.join(ROOT, "src", "lib", "push-client.ts"), "utf8");
    assert.doesNotMatch(client, /privateKey|VAPID_PRIVATE|auth: subscription\.keys/);
  });
});
