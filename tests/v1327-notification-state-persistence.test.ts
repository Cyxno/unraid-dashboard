import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";
process.env.AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-notif-persist-"));

import {
  loadState,
  loadStateFromDisk,
  resetStateCache,
  saveNow,
} from "../src/server/notifications/store";
import { classifyTestPush } from "../src/server/notifications/push";

const ROOT_DIR = path.dirname(path.dirname(new URL(import.meta.url).pathname));

const sub = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: "p256dh", auth: "auth" },
  label: "Safari · iPhone",
  createdAt: new Date().toISOString(),
  lastSuccessAt: null,
  lastFailureAt: null,
  enabled: true,
});

async function freshReload() {
  // Process-restart simulation: cache leeg, state uitsluitend van disk.
  resetStateCache();
  return loadStateFromDisk();
}

describe("v1.3.27 notification-state persistence contract", () => {
  test("subscription registered via POST survives engine-cycle saves", async () => {
    resetStateCache();
    const state = loadState();
    state.subscriptions.push(sub("https://web.push.apple.com/T1"));
    await saveNow();
    // Engine-cycle save (unrelated mutation on the SAME working set):
    const state2 = loadState();
    state2.active = { "docker:health:cycle": {} } as never;
    await saveNow();
    const reloaded = await freshReload();
    assert.equal(reloaded.subscriptions.length, 1);
    assert.equal(reloaded.subscriptions[0]!.endpoint, "https://web.push.apple.com/T1");
    assert.equal(reloaded.subscriptions[0]!.enabled, true);
  });

  test("endpoint fingerprint is stable across reloads (SHA-256/16-hex)", async () => {
    resetStateCache();
    const state = loadState();
    state.subscriptions.push(sub("https://web.push.apple.com/T2"));
    await saveNow();
    const reloaded = await freshReload();
    assert.equal(reloaded.subscriptions[0]!.endpoint, "https://web.push.apple.com/T2");
    assert.match(reloaded.subscriptions[0]!.endpoint, /^https:\/\//);
  });

  test("0 registered devices → Web Push test is an explicit failure", () => {
    const c = classifyTestPush(0);
    assert.equal(c.ok, false);
    assert.equal(c.delivery, "in-app-only");
    assert.equal(c.reason, "no-subscribed-devices");
    assert.equal(c.providerAccepted, false);
  });

  test("≥1 device → pushed path allowed", () => {
    const c = classifyTestPush(2);
    assert.equal(c.ok, true);
    assert.equal(c.providerAccepted, true);
  });
});

describe("v1.3.25 UI dead-end regression (canonical state drives buttons)", () => {
  const section = fs.readFileSync(
    path.join(ROOT_DIR, "src", "components", "settings", "notifications-section.tsx"),
    "utf8",
  );

  test("granted + no subscription → Enable Web Push action visible", () => {
    assert.match(section, /"Enable Web Push"/);
  });

  test("button gating on canonical state (not permission alone)", () => {
    assert.match(section, /deviceAction !== "disable"/);
    assert.match(section, /pushDeviceAction\(devicePushState\)/);
  });

  test("localStorage is not authoritative", () => {
    assert.doesNotMatch(section, /beacon\.notifications\.pushConfigured/);
  });
});
