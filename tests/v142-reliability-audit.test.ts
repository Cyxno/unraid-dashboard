/**
 * v1.4.2 post-stable reliability audit — regression tests.
 *
 * Every test pins a failure mode the audit found that existing release
 * gates did not catch:
 *
 *   P0-1  boot hydration race: a request landing before the engine's first
 *         cycle initialized an empty global that shadowed (and then
 *         overwrote) the persisted notification state.
 *   P1-1  persistence failures were swallowed — saveNow now records and
 *         logs the error, and clears it on the next successful save.
 *   P1-2  a permanently failing evaluation cycle was invisible (empty
 *         catch) — it now logs, bounded to one line per cycle.
 *   P1-3  push delivery had no timeout — a hung push service stalled the
 *         engine forever while health stayed green.
 *   P2-1  SectionProvider had no failure backoff: during an upstream
 *         outage every poll fired a live request (cache was destroyed).
 *   P2-2  a transient registry failure froze update evidence for the full
 *         4h TTL — failures now expire after 60s.
 *   P2-3  helper-inventory last-known-good was served without an age
 *         ceiling and stamped `checkedAt = now` — stale facts read as
 *         fresh. LKG older than 15 minutes is refused.
 *   P2-4  the system section fired SYSTEM_QUERY twice per refresh.
 *   P2-5  getNetwork() constructed a throwaway SectionProvider per call —
 *         its TTL cache never engaged.
 *   P2-6  automation store: two concurrent first loads produced two
 *         copies; the losing saveState dropped the winner's mutations.
 *   P2-7  recordEvent wrote a dead `null` temp file before the real one.
 */

import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";
process.env.AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-v142-audit-"));
process.env.UPDATE_HELPER_URL ??= "http://127.0.0.1:8790";
// Push configured so the delivery path (and its timeout) is reachable.
process.env.BEACON_VAPID_PUBLIC_KEY ??=
  "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHB1FLvYxc7atQmMP";
process.env.BEACON_VAPID_PRIVATE_KEY ??= "UPSN1IigtLYZLI_L4jGCyWji8U9RMgkJCXizJMz0YzM";

import {
  ensureNotificationState,
  lastSaveError,
  loadState,
  resetStateCache,
  saveNow,
} from "../src/server/notifications/store";
import {
  setPushSendTimeoutForTests,
  setPushTransportForTests,
  sendToSubscription,
} from "../src/server/notifications/push";
import {
  runEvaluationCycle,
  setEventSourceForTests,
} from "../src/server/notifications";
import { SectionProvider } from "../src/server/unraid/section";
import {
  INVENTORY_LKG_MAX_AGE_MS,
  cacheTtlForOutcome,
  fetchInventory,
  resetUpdateDetection,
  updatesSummaryFromCache,
} from "../src/server/docker/updates";
import {
  loadState as loadAutomationState,
  readEvents,
  recordEvent,
  resetAutomationStores,
} from "../src/server/automation/store";

const subscription = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: "p256dh", auth: "auth" },
  label: "audit-device",
  createdAt: new Date().toISOString(),
  lastSuccessAt: null,
  lastFailureAt: null,
  enabled: true,
});

/* ---- P0-1: boot hydration ------------------------------------------------ */

describe("v1.4.2 P0-1: notification state hydrates before first mutation", () => {
  test("ensureNotificationState loads the disk file exactly once and the working set is that object", async () => {
    resetStateCache();
    // Seed a persisted state (what a previous container life left behind).
    const seeded = await ensureNotificationState();
    seeded.subscriptions.push(subscription("https://web.push.apple.com/seed-1"));
    await saveNow();

    // Process-restart simulation: the global is empty again.
    resetStateCache();
    const [first, second] = await Promise.all([
      ensureNotificationState(),
      ensureNotificationState(),
    ]);
    assert.equal(first, second, "hydration must be memoized (one working set)");
    assert.equal(first.subscriptions.length, 1, "disk state must win, not an empty default");
    assert.equal(first.subscriptions[0]!.endpoint, "https://web.push.apple.com/seed-1");
    assert.equal(loadState(), first, "sync loadState() must be the hydrated object");
  });

  test("a route-style ensure→mutate→save cycle survives a later reload", async () => {
    resetStateCache();
    const state = await ensureNotificationState();
    state.subscriptions.push(subscription("https://web.push.apple.com/post-1"));
    await saveNow();
    resetStateCache();
    const reloaded = await ensureNotificationState();
    const posted = reloaded.subscriptions.filter(
      (entry) => entry.endpoint === "https://web.push.apple.com/post-1",
    );
    assert.equal(posted.length, 1, "the route's mutation must persist across reload");
    assert.equal(posted[0]!.enabled, true);
  });
});

/* ---- P1-1: save-failure observability ------------------------------------ */

describe("v1.4.2 P1-1: persistence failures are recorded, not swallowed", () => {
  test("a failing save records lastSaveError and the next good save clears it", async () => {
    resetStateCache();
    await ensureNotificationState();
    assert.equal(lastSaveError(), null);
    // Block the atomic temp write: a DIRECTORY sits where the .tmp file
    // must be written (EISDIR), simulating an unwritable data volume.
    const tmpPath = path.join(process.env.AUDIT_DIR!, "notifications-state.json.tmp");
    fs.mkdirSync(tmpPath);
    try {
      await assert.rejects(() => saveNow());
      const error = lastSaveError();
      assert.ok(error, "save failure must be observable");
      assert.match(error!.message, /EISDIR|illegal operation|not a file|directory/i);
    } finally {
      fs.rmdirSync(tmpPath);
    }
    await saveNow();
    assert.equal(lastSaveError(), null, "recovery must clear the error");
  });
});

/* ---- P1-2: cycle failure logging ------------------------------------------ */

describe("v1.4.2 P1-2: a failing evaluation cycle logs instead of vanishing", () => {
  test("runEvaluationCycle swallows the error but logs one line", async () => {
    resetStateCache();
    await ensureNotificationState();
    const original = console.error;
    const captured: unknown[] = [];
    console.error = (...args: unknown[]) => captured.push(args);
    setEventSourceForTests(() => Promise.reject(new Error("source explosion")));
    try {
      await assert.doesNotReject(() => runEvaluationCycle());
    } finally {
      setEventSourceForTests(null);
      console.error = original;
    }
    const flat = captured.map((entry) => JSON.stringify(entry)).join(" ");
    assert.match(flat, /evaluation cycle failed/);
    assert.match(flat, /source explosion/);
  });
});

/* ---- P1-3: push delivery timeout ------------------------------------------ */

describe("v1.4.2 P1-3: push delivery is bounded in time", () => {
  test("a hung push service resolves as a failed outcome instead of stalling", async () => {
    setPushTransportForTests(() => new Promise(() => {}));
    setPushSendTimeoutForTests(50);
    try {
      const started = Date.now();
      const outcome = await sendToSubscription(
        {
          endpoint: "https://web.push.apple.com/hang",
          keys: { p256dh: "p", auth: "a" },
          label: "hang",
          createdAt: new Date().toISOString(),
          lastSuccessAt: null,
          lastFailureAt: null,
          enabled: true,
        },
        { title: "t", body: "b", tag: "tag", url: "/", severity: "warning" },
      );
      const elapsed = Date.now() - started;
      assert.equal(outcome.ok, false, "timeout must read as a failed delivery");
      assert.equal(outcome.retryable, false);
      assert.ok(elapsed < 5_000, `delivery must not hang (took ${elapsed}ms)`);
    } finally {
      setPushTransportForTests(null);
      setPushSendTimeoutForTests(null);
    }
  });
});

/* ---- P2-1: SectionProvider failure backoff -------------------------------- */

describe("v1.4.2 P2-1: SectionProvider backs off after a failed refresh", () => {
  test("within the backoff window the degraded answer is served without refetching", async () => {
    let calls = 0;
    const provider = new SectionProvider<string>(
      "backoff",
      async () => {
        calls += 1;
        if (calls === 2) throw new Error("upstream down");
        return "good";
      },
      30,
      { failureBackoffMs: 100 },
    );
    assert.equal((await provider.get()).data, "good");
    await new Promise((resolve) => setTimeout(resolve, 60)); // TTL expires, fetch fails
    const stale = await provider.get();
    assert.equal(stale.status, "stale");
    assert.equal(stale.data, "good");
    const again = await provider.get();
    assert.equal(calls, 2, "backoff window must not wake upstream again");
    assert.equal(again.status, "stale");
    await new Promise((resolve) => setTimeout(resolve, 150)); // backoff expired
    const recovered = await provider.get();
    assert.equal(calls, 3, "after the backoff window exactly one refetch happens");
    assert.equal(recovered.status, "live");
  });

  test("no last-known-good: the backoff window serves unavailable without refetch", async () => {
    let calls = 0;
    const provider = new SectionProvider<string>(
      "backoff-unavailable",
      async () => {
        calls += 1;
        throw new Error("never up");
      },
      20,
      { failureBackoffMs: 500 },
    );
    const first = await provider.get();
    assert.equal(first.status, "unavailable");
    const second = await provider.get();
    assert.equal(second.status, "unavailable");
    assert.equal(calls, 1, "unavailable must also respect the backoff window");
  });
});

/* ---- P2-2: registry check TTL on failure ----------------------------------- */

describe("v1.4.2 P2-2: transient registry failures expire quickly", () => {
  test("failed checks get a 60s TTL; real answers keep the 4h TTL", () => {
    assert.equal(cacheTtlForOutcome({ kind: "failed", reason: "boom" }), 60_000);
    assert.equal(cacheTtlForOutcome({ kind: "digest", remoteDigest: "sha256:aa" }), 4 * 60 * 60 * 1000);
    assert.equal(cacheTtlForOutcome({ kind: "not_found", reason: "local build" }), 4 * 60 * 60 * 1000);
    assert.equal(cacheTtlForOutcome({ kind: "auth_required", reason: "private" }), 4 * 60 * 60 * 1000);
  });
});

/* ---- P2-3: helper inventory LKG ceiling ------------------------------------ */

describe("v1.4.2 P2-3: stale helper inventory is degraded and bounded", () => {
  const validBody = {
    version: "1.4.1",
    containers: [
      {
        id: "abc123def456",
        name: "sample",
        image: "ghcr.io/example/sample:1.0.0",
        state: "running",
        status: "Up 2 hours",
      },
    ],
    storage: { mode: "btrfs", source: null },
  };

  test("fetchInventory marks last-known-good as degraded when the helper fails", async () => {
    resetUpdateDetection();
    const original = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        json: async () => validBody,
      })) as unknown as typeof fetch;
      const fresh = await fetchInventory();
      assert.ok(fresh);
      assert.equal(fresh!.degraded, false);
      assert.equal(fresh!.containers.length, 1);

      globalThis.fetch = (async () => {
        throw new Error("helper down");
      }) as unknown as typeof fetch;
      const degraded = await fetchInventory();
      assert.ok(degraded, "LKG must still be served");
      assert.equal(degraded!.degraded, true, "served-from-cache must be marked degraded");
      assert.equal(degraded!.containers.length, 1);
      assert.ok(degraded!.at <= Date.now());
    } finally {
      globalThis.fetch = original;
    }
  });

  test("LKG ceiling is 15 minutes and an aged cache marks the summary stale", async () => {
    assert.equal(INVENTORY_LKG_MAX_AGE_MS, 15 * 60 * 1000);
    resetUpdateDetection();
    // No inventory at all → the summary is honest about it.
    const empty = updatesSummaryFromCache();
    assert.equal(empty.available, false);
    assert.equal(empty.stale, false, "no data must not read as stale-fresh");
  });
});

/* ---- P2-4 + P2-5: service-level request hygiene ----------------------------- */

describe("v1.4.2 P2-4/P2-5: unraid service issues one query per domain refresh", () => {
  test("systemProvider fires SYSTEM_QUERY exactly once per refresh", () => {
    const service = fs.readFileSync("src/server/unraid/service.ts", "utf8");
    const start = service.indexOf("const systemProvider");
    const end = service.indexOf("30_000", start);
    const block = service.slice(start, end);
    const occurrences = block.match(/client\.request\(SYSTEM_QUERY\)/g)?.length ?? 0;
    assert.equal(occurrences, 1, "SYSTEM_QUERY must be requested once in the system section fetcher");
  });

  test("getNetwork uses the module-level provider (TTL cache engaged)", () => {
    const service = fs.readFileSync("src/server/unraid/service.ts", "utf8");
    assert.match(service, /const networkInterfacesProvider = new SectionProvider<any>\(/);
    const occurrences = service.split("network-interfaces").length - 1;
    assert.equal(occurrences, 1, "the network provider must be constructed once at module level");
  });
});

/* ---- P2-6 + P2-7: automation store ----------------------------------------- */

describe("v1.4.2 P2-6/P2-7: automation store load race and event feed", () => {
  test("concurrent first loads share one working set", async () => {
    resetAutomationStores();
    const persisted = {
      policyVersion: "audit",
      config: {},
      targets: { sample: { optIn: true, cooldownUntil: null, cooldownReason: null, interventionRequired: false, interventionReason: null } },
      windowOperationsUsed: 2,
      windowStartedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(process.env.AUDIT_DIR!, "automation-state.json"),
      JSON.stringify(persisted),
    );
    const [a, b] = await Promise.all([loadAutomationState(), loadAutomationState()]);
    assert.equal(a, b, "both callers must receive the SAME object");
    assert.equal(a.targets.sample?.optIn, true, "disk contents must be loaded, not defaults");
  });

  test("recordEvent appends to the readable bounded feed (no dead temp writes)", async () => {
    resetAutomationStores();
    const event = await recordEvent("config_changed", null, "audit event feed probe");
    const events = await readEvents(10);
    assert.ok(events.some((entry) => entry.id === event.id));
    // The removed dead write used to leave a `null` temp file behind; the
    // only artifact now is the feed itself (plus its transient .tmp).
    const leftovers = fs
      .readdirSync(process.env.AUDIT_DIR!)
      .filter((name) => name.startsWith("automation-events.jsonl"));
    assert.ok(leftovers.includes("automation-events.jsonl"));
  });
});
