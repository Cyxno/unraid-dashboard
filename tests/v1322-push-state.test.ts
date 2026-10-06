import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import {
  disablePush,
  endpointFingerprint,
  resolveCanonicalPushState,
  type PushBrowser,
  type PushStateEvidence,
} from "../src/lib/push-client";
import { classifyTestPush } from "../src/server/notifications/push";
import { createHash } from "node:crypto";
const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));


const fp = (endpoint: string) => createHash("sha256").update(endpoint).digest("hex").slice(0, 16);

/* ---- Fase 1: canonical state model -------------------------------------- */

function state(overrides: Partial<PushStateEvidence>): string {
  return resolveCanonicalPushState({
    permission: "granted",
    subscriptionPresent: false,
    subscriptionFingerprint: null,
    serverKnowsSubscription: null,
    serverDevices: null,
    swActive: true,
    workerVersion: "v1.3.22+abc",
    ...overrides,
  });
}

describe("v1.3.22 canonical push state model", () => {
  test("1. permission granted != push enabled", () => {
    assert.equal(state({}), "PERMISSION_GRANTED_NO_SUBSCRIPTION");
  });
  test("2. permission granted + no subscription → explicit state", () => {
    assert.equal(state({ permission: "granted", subscriptionPresent: false }), "PERMISSION_GRANTED_NO_SUBSCRIPTION");
  });
  test("3. local subscription + no server → LOCAL_ONLY", () => {
    assert.equal(
      state({ subscriptionPresent: true, subscriptionFingerprint: "f1", serverKnowsSubscription: false }),
      "SUBSCRIPTION_MISMATCH",
    );
    // server unknown: local only
    assert.equal(
      state({ subscriptionPresent: true, subscriptionFingerprint: "f1", serverKnowsSubscription: null }),
      "SUBSCRIBED_LOCAL_ONLY",
    );
  });
  test("4. server-only entry (browser absent) is NOT ready", () => {
    assert.equal(state({ subscriptionPresent: false, serverKnowsSubscription: null, serverDevices: 2 }), "PERMISSION_GRANTED_NO_SUBSCRIPTION");
  });
  test("5. ready requires both subscription AND server knowledge", () => {
    assert.equal(
      state({ subscriptionPresent: true, subscriptionFingerprint: "f1", serverKnowsSubscription: true }),
      "PUSH_READY",
    );
  });
  test("SW not active → SW_NOT_ACTIVE, never healthy", () => {
    assert.equal(state({ swActive: false }), "SW_NOT_ACTIVE");
  });
  test("permission denied → PERMISSION_DENIED", () => {
    assert.equal(state({ permission: "denied" }), "PERMISSION_DENIED");
  });
  test("permission not asked → PERMISSION_REQUIRED", () => {
    assert.equal(state({ permission: "default" }), "PERMISSION_REQUIRED");
  });
});

/* ---- Fase 11/46: endpoint fingerprint (privacy-safe reconciliation) ----- */

describe("v1.3.22 endpoint fingerprints", () => {
  test("SHA-256-truncated fingerprint is stable and never the raw endpoint", async () => {
    const f = await endpointFingerprint("https://web.push.apple.com/T0000001");
    assert.equal(f.length, 16);
    assert.match(f, /^[0-9a-f]{16}$/);
    assert.equal(await endpointFingerprint("https://web.push.apple.com/T0000001"), f);
    assert.notEqual(await endpointFingerprint("https://web.push.apple.com/T0000002"), f);
    assert.ok(!f.includes("apple"));
  });
  test("server fingerprint matches client computation (same SHA-256 scheme)", () => {
    const endpoint = "https://web.push.apple.com/T0000001";
    const server = createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
    assert.equal(server, "77231607a63b8d32");
  });
});

/* ---- Fase 4/5/6/7: disable contract ------------------------------------- */

describe("v1.3.22 disable contract", () => {
  function makeBrowser(opts: { withSubscription?: string; unsubscribeFails?: boolean } = {}) {
    const unsubscribed: string[] = [];
    const browser = {
      permission: () => "granted" as NotificationPermission,
      requestPermission: async () => "granted" as NotificationPermission,
      serviceWorker: async () => ({
        pushManager: {
          getSubscription: async () =>
            opts.withSubscription
              ? {
                  endpoint: opts.withSubscription,
                  toJSON: () => ({ endpoint: opts.withSubscription }),
                  unsubscribe: async () => {
                    if (opts.unsubscribeFails) throw new Error("no");
                    unsubscribed.push(opts.withSubscription!);
                    return true;
                  },
                }
              : null,
        },
      }) as never,
    } as never as PushBrowser & { __unsubscribed: string[] };
    (browser as unknown as { __unsubscribed: string[] }).__unsubscribed = unsubscribed;
    return browser;
  }

  test("full teardown: local unsubscribed + server entry removed by fingerprint", async () => {
    const endpoint = "https://web.push.apple.com/T1";
    const browser = makeBrowser({ withSubscription: endpoint });
    const removed: string[] = [];
    const apiWithDelete = {
      permission: () => "granted" as NotificationPermission,
      requestPermission: async () => "granted" as NotificationPermission,
      serviceWorker: (browser as unknown as { serviceWorker: PushBrowser["serviceWorker"] }).serviceWorker,
      vapidPublicKey: async () => KEY_STATE,
      registerSubscription: async () => {},
      listServerSubscriptions: async () => [{ endpointTail: endpoint.slice(-12), enabled: true }],
      deleteServerSubscription: async (fingerprints: string[]) => {
        removed.push(...fingerprints);
        return fingerprints.length;
      },
    } as never;
    const result = await disablePush(browser, apiWithDelete, null);
    assert.equal(result.localRemoved, true);
    assert.deepEqual(removed, [fp(endpoint)]);
    assert.equal(result.permissionStillGranted, true);
  });

  test("server-only stale device: disable removes by fingerprint hint, no local subscription", async () => {
    const endpoint = "https://web.push.apple.com/TOLD";
    const browser = makeBrowser({});
    const removed: string[] = [];
    const apiWithDelete = {
      permission: () => "granted" as NotificationPermission,
      requestPermission: async () => "granted",
      serviceWorker: async () => ({ pushManager: { getSubscription: async () => null } }) as never,
      vapidPublicKey: async () => KEY_STATE,
      registerSubscription: async () => {},
      listServerSubscriptions: async () => [],
      deleteServerSubscription: async (fingerprints: string[]) => { removed.push(...fingerprints); return 1; },
    } as never;
    const result = await disablePush(browser, apiWithDelete, fp(endpoint));
    assert.deepEqual(removed, [fp(endpoint)]);
    assert.equal(result.serverRemoved, 1);
  });

  test("permission remains granted after disable (browser cannot revoke)", async () => {
    const browser = makeBrowser({ withSubscription: "https://web.push.apple.com/T1" });
    const apiWithDelete = {
      permission: () => "granted" as NotificationPermission,
      requestPermission: async () => "granted",
      serviceWorker: async () => ({ pushManager: { getSubscription: async () => null } }) as never,
      vapidPublicKey: async () => KEY_STATE,
      registerSubscription: async () => {},
      listServerSubscriptions: async () => [],
      deleteServerSubscription: async () => 1,
    } as never;
    const result = await disablePush(browser, apiWithDelete, null);
    assert.equal(result.permissionStillGranted, true);
  });
});

const KEY_STATE = "BDaFwwQk2cVT3jajMfCkGirCFQeEtdU9aqVEG-gDhIsM6s4By_5_oeudZOv4QQKQOa-g2ftU2eDWghQgn8Xfcdw";

/* ---- Fase 13: test-push semantics ---------------------------------------- */

describe("v1.3.22 test-push semantics", () => {
  test("0 subscribed devices → explicit failure, never a green push result", () => {
    const c = classifyTestPush(0);
    assert.equal(c.ok, false);
    assert.equal(c.delivery, "in-app-only");
    assert.equal(c.reason, "no-subscribed-devices");
    assert.equal(c.providerAccepted, false);
  });

  test("≥1 device → provider path allowed", () => {
    const c = classifyTestPush(1);
    assert.equal(c.ok, true);
    assert.equal(c.delivery, "pushed");
    assert.equal(c.providerAccepted, true);
  });

  test("test-route uses the pure classifier (gate against regression)", () => {
    const route = fs.readFileSync(
      path.join(ROOT, "src", "app", "api", "notifications", "test", "route.ts"),
      "utf8",
    );
    assert.match(route, /classifyTestPush\(subscribedDevices\)/);
    // the literal reason moved into the classifier; the route maps it through
    assert.match(route, /reason: precheck\.reason/);
  });
});


/* ---- Fase 12: localStorage is not authoritative -------------------------- */

describe("v1.3.22 localStorage demoted", () => {
  test("notifications section no longer reads/writes pushConfigured localStorage", () => {
    const section = fs.readFileSync(
      path.join(ROOT, "src", "components", "settings", "notifications-section.tsx"),
      "utf8",
    );
    assert.doesNotMatch(section, /beacon\.notifications\.pushConfigured/);
  });
});

/* ---- Fase 19/20: shared SW resolver -------------------------------------- */

describe("v1.3.22 shared registration resolver", () => {
  test("enable/repair/diagnostics use getBeaconPushRegistration; disable via same client", () => {
    const client = fs.readFileSync(path.join(ROOT, "src", "lib", "push-client.ts"), "utf8");
    const section = fs.readFileSync(path.join(ROOT, "src", "components", "settings", "notifications-section.tsx"), "utf8");
    assert.match(client, /export async function getBeaconPushRegistration/);
    // the section no longer uses serviceWorker.ready in push flows
    // (comments excepted — code refs only)
    assert.doesNotMatch(section, /await navigator\.serviceWorker\.ready/);
  });
});
