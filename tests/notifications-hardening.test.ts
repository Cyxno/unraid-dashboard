import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Hardening regressions for the notification pipeline:
 * - first-run baseline: activating notifications on a server with EXISTING
 *   problems must never flood devices (silent ingest, transitions only)
 * - restart dedupe: the persisted active set survives process restarts —
 *   recreating Beacon never re-pushes known conditions
 * - corrupt state file: recovery instead of crash
 * - deep links: same-origin only, arbitrary URLs normalized away
 * - iOS/permission support classification
 */

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
  delete process.env.BEACON_VAPID_PUBLIC_KEY;
  delete process.env.BEACON_VAPID_PRIVATE_KEY;
  resetEnvCache();
});

import { resetEnvCache } from "../src/server/env";
import * as pushSupport from "../src/lib/push-support";
import type { RawEvent } from "../src/server/notifications/types";

async function isolatedStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "notify-harden-"));
  const previous = process.env.AUDIT_DIR;
  process.env.AUDIT_DIR = dir;
  const { resetStateCache } = await import("../src/server/notifications/store");
  resetStateCache();
  restores.push(() => {
    if (previous === undefined) delete process.env.AUDIT_DIR;
    else process.env.AUDIT_DIR = previous;
    resetStateCache();
  });
  return dir;
}


function condition(): RawEvent {
  return {
    fingerprint: "docker:container:plex:unhealthy",
    category: "docker-health",
    severity: "critical",
    title: "Container unhealthy: plex",
    body: "Health check failed.",
    source: "docker",
    url: "/docker/plex",
    occurredAt: Date.now(),
  };
}

function subscription(endpoint: string) {
  return {
    endpoint,
    keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
    label: 'test',
    createdAt: '2026-10-02T00:00:00.000Z',
    lastSuccessAt: null,
    lastFailureAt: null,
    enabled: true,
  };
}

function withVapid(): void {
  process.env.BEACON_VAPID_PUBLIC_KEY = 'B' + 'k'.repeat(86);
  process.env.BEACON_VAPID_PRIVATE_KEY = 'priv' + 'e'.repeat(20);
  resetEnvCache();
}

describe("first-run baseline (anti-spam)", () => {
  it("ingests existing conditions silently: no dispatch, baseline recorded", async () => {
    await isolatedStateDir();
    const { runEvaluationCycle, setEventSourceForTests } = await import("../src/server/notifications");
    setEventSourceForTests(async () => [condition()]);
    restores.push(() => setEventSourceForTests(null));
    const { loadStateFromDisk } = await import("../src/server/notifications/store");

    await runEvaluationCycle();
    const state = await loadStateFromDisk();
    assert.ok(state.baselinedAt !== null, "baseline must be recorded");
    // A real condition exists — but the baseline must NOT dispatch it.
    const dispatched = state.history.filter((entry) => entry.delivery === "pushed" || entry.delivery === "in-app");
    assert.equal(dispatched.length, 0, "baseline cycle must not dispatch anything");
    assert.ok(Object.keys(state.active).length > 0, "existing conditions are still recorded as active");
  });

  it("after the baseline, a NEW transition dispatches normally", async () => {
    await isolatedStateDir();
    const { runEvaluationCycle, setEventSourceForTests } = await import("../src/server/notifications");
    let conditionPresent = true;
    setEventSourceForTests(async () => (conditionPresent ? [condition()] : []));
    restores.push(() => setEventSourceForTests(null));
    await runEvaluationCycle(); // baseline

    const { loadState } = await import("../src/server/notifications/store");
    conditionPresent = false;
    await runEvaluationCycle();
    conditionPresent = true;
    await runEvaluationCycle();
    const after = loadState();
    const dispatched = after.history.filter((entry) => entry.delivery === "in-app" && entry.kind === "event");
    assert.ok(dispatched.length > 0, "a genuinely new condition after baseline must notify");
  });
});

describe("restart dedupe (persistence proof)", () => {
  it("recreating the process does not re-push known conditions", async () => {
    const dir = await isolatedStateDir();
    const { runEvaluationCycle, setEventSourceForTests } = await import("../src/server/notifications");
    const store = await import("../src/server/notifications/store");
    setEventSourceForTests(async () => [condition()]);
    restores.push(() => setEventSourceForTests(null));

    await runEvaluationCycle(); // first boot: baseline
    // Drop one condition from disk state = it "resolved"; keep the rest.
    const state = store.loadState();
    const fingerprints = Object.keys(state.active);
    assert.ok(fingerprints.length >= 1);
    await runEvaluationCycle(); // settles: resolved + (registry still 9.9.9 → new beacon:update event may notify once)

    // Simulate a process RESTART: only the in-memory cache is lost.
    store.resetStateCache();
    const before = (await store.loadStateFromDisk()).history.filter((e) => e.delivery === "pushed" || e.delivery === "in-app").length;
    await runEvaluationCycle();
    await runEvaluationCycle();
    const after = (await store.loadStateFromDisk()).history.filter((e) => e.delivery === "pushed" || e.delivery === "in-app").length;
    assert.equal(after, before, "restart must not produce additional notifications for known conditions");
    assert.ok(dir.length > 0);
  });
});

describe("store corruption safety", () => {
  it("a malformed state file recovers to a clean baseline instead of crashing", async () => {
    const dir = await isolatedStateDir();
    await writeFile(path.join(dir, "notifications-state.json"), "{ this is not json !!!", "utf8");
    const { loadStateFromDisk } = await import("../src/server/notifications/store");
    const state = await loadStateFromDisk();
    assert.equal(state.baselinedAt, null);
    assert.deepEqual(state.active, {});
    assert.deepEqual(state.subscriptions, []);
    // The corrupt file is only replaced on the next save — no crash, app intact.
    const raw = await readFile(path.join(dir, "notifications-state.json"), "utf8");
    assert.match(raw, /not json/);
  });
});

describe("push deep-link normalization", () => {
  it("non-relative URLs are normalized to '/' — no arbitrary open-redirect targets", async () => {
    withVapid();
    const { sendToSubscription, setPushTransportForTests } = await import("../src/server/notifications/push");
    const holder: { captured: { url: string } | null } = { captured: null };
    setPushTransportForTests(async (_subscription, payload) => {
      holder.captured = JSON.parse(payload) as { url: string };
      return { status: 200 };
    });
    restores.push(() => setPushTransportForTests(null));

    await sendToSubscription(subscription("https://push.example/link"), {
      title: "t", body: "b", tag: "x",
      url: "https://evil.example/phishing",
      severity: "info",
    });
    assert.ok(holder.captured);
    assert.equal(holder.captured.url, "/", "only internal routes may be notification targets");
  });
});

describe("push support classification (iOS/permission UX)", () => {
  it("iPhone Safari (not installed) requires Home Screen install", () => {
    const { evaluatePushSupport } = pushSupport;
    const support = evaluatePushSupport({
      hasNotificationApi: false,
      hasPushManager: false,
      hasServiceWorker: false,
      secureContext: true,
      isAppleMobile: true,
      standalone: false,
    });
    assert.equal(support.kind, "ios-needs-install");
  });

  it("installed iPhone PWA with push APIs is supported", () => {
    const { evaluatePushSupport } = pushSupport;
    const support = evaluatePushSupport({
      hasNotificationApi: true,
      hasPushManager: true,
      hasServiceWorker: true,
      secureContext: true,
      isAppleMobile: true,
      standalone: true,
    });
    assert.equal(support.kind, "supported");
  });

  it("desktop without push APIs is unsupported (not 'install required')", () => {
    const { evaluatePushSupport } = pushSupport;
    const support = evaluatePushSupport({
      hasNotificationApi: false,
      hasPushManager: false,
      hasServiceWorker: false,
      secureContext: true,
      isAppleMobile: false,
      standalone: false,
    });
    assert.equal(support.kind, "unsupported-browser");
  });

  it("insecure context (plain HTTP LAN) classifies before anything else", () => {
    const { evaluatePushSupport } = pushSupport;
    const support = evaluatePushSupport({
      hasNotificationApi: true,
      hasPushManager: true,
      hasServiceWorker: true,
      secureContext: false,
      isAppleMobile: false,
      standalone: false,
    });
    assert.equal(support.kind, "insecure-context");
  });

  it("iPadOS 13+ masquerading as Macintosh is detected as Apple mobile", () => {
    const { isAppleMobile } = pushSupport;
    assert.equal(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15", 5), true);
    assert.equal(isAppleMobile("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0", 0), false);
  });
});
