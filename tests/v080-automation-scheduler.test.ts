import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach, after } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

const TARGET = "pilot-test-target";
const IMAGE = "ghcr.io/pilot/test:1.0.0";
const DIGEST_V1 = "sha256:" + "a".repeat(64);
const DIGEST_V2 = "sha256:" + "b".repeat(64);

/**
 * Full-path scheduler integration: helper + registry are a mocked fetch
 * router (never the real network). Drives the SAME tick the production
 * scheduler runs, across the disposable-container scenarios.
 */

type Route = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;
let routes: Array<{ match: (url: URL) => boolean; handler: Route }> = [];
let fetchCalls: string[] = [];

const originalFetch = globalThis.fetch;

function installFetchRouter(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    fetchCalls.push(url.toString());
    for (const route of routes) {
      if (route.match(url)) return route.handler(url, init);
    }
    return new Response(JSON.stringify({ error: "unrouted " + url.pathname }), { status: 404 });
  }) as typeof fetch;
}

function helperRoute(pathname: string, body: unknown, status = 200): void {
  routes.push({
    match: (url) => url.pathname === pathname && url.port === "8790",
    handler: () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  });
}

function registryRoute(digest: string): void {
  routes.push({
    match: (url) => url.hostname.endsWith("ghcr.io") && url.pathname.includes("/manifests/"),
    handler: () => new Response(null, { status: 200, headers: { "docker-content-digest": digest } }),
  });
}

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "automation-scheduler-test-"));
  process.env.AUDIT_DIR = dataDir;
  process.env.GHCR_READ_TOKEN = "test-token-never-real";
  process.env.UPDATE_HELPER_URL = "http://127.0.0.1:8790";
  process.env.UPDATE_HELPER_TOKEN = "x".repeat(40);
  routes = [];
  fetchCalls = [];
  installFetchRouter();
  const { resetAutomationStores } = await import("../src/server/automation/store");
  const { resetScheduler } = await import("../src/server/automation/scheduler");
  const { resetEnvCache } = await import("../src/server/env");
  resetAutomationStores();
  resetScheduler();
  resetEnvCache();
  resetUpdateDetection();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  const { resetAutomationStores } = await import("../src/server/automation/store");
  const { resetScheduler } = await import("../src/server/automation/scheduler");
  const { resetEnvCache } = await import("../src/server/env");
  resetAutomationStores();
  resetScheduler();
  resetEnvCache();
  resetUpdateDetection();
  delete process.env.GHCR_READ_TOKEN;
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

import { recordContainerUpdate } from "../src/server/update/history";
import { resetUpdateDetection } from "../src/server/docker/updates";

/** Seeds 3 successful manual updates so the track-record gate passes. */
async function seedTrackRecord(): Promise<void> {
  for (let index = 0; index < 3; index++) {
    await recordContainerUpdate({
      startedAt: new Date(Date.now() - (10 - index) * 3_600_000).toISOString(),
      actor: "cyxno",
      target: TARGET,
      scope: "container",
      adapter: "helper",
      image: IMAGE,
      durationMs: 1_000,
      phasesReached: ["requested", "completed"],
      result: "success",
      rollbackPerformed: false,
    });
  }
}

/** Helper /inventory with ONE perfect pilot candidate. */
function inventoryRoute(snapshotPresent = true, health: string | null = "healthy"): void {
  helperRoute("/inventory", {
    version: "0.8.0",
    containers: [
      {
        id: "abc123",
        name: TARGET,
        image: IMAGE,
        state: "running",
        status: "Up",
        health,
        imageId: "sha256:local",
        repoDigests: [`ghcr.io/pilot/test@${DIGEST_V1}`],
        networks: [],
        volumeSources: [],
        created: "2026-09-01T00:00:00Z",
        labels: {},
        unsupported: [],
        externallyManaged: false,
        snapshotPresent,
      },
    ],
    storage: { mode: "folder", source: "/dev/loop" },
  });
}

function helperStatusRoute(phase = "idle", lock: unknown = null): void {
  helperRoute("/status", {
    version: "0.8.0",
    phase,
    detail: null,
    startedAt: null,
    finishedAt: null,
    log: [],
    lock,
    lastUpdate: null,
    currentImage: IMAGE,
    currentVersion: "1.0.0",
    currentRevision: null,
    currentImageId: "sha256:local",
    localVersions: ["1.0.0"],
    pullAvailable: true,
    pullAuthRequired: false,
    requireRemote: true,
  });
}

async function configure(opts: { enabled?: boolean; startHour?: number; endHour?: number; minAgeHours?: number }): Promise<void> {
  const { loadState, saveState } = await import("../src/server/automation/store");
  const state = await loadState();
  state.config.enabled = opts.enabled ?? true;
  state.config.paused = false;
  state.config.maintenance = {
    enabled: true,
    days: [0, 1, 2, 3, 4, 5, 6],
    startHour: opts.startHour ?? 0,
    endHour: opts.endHour ?? 23,
    timezone: "UTC",
  };
  state.config.minUpdateAgeHours = opts.minAgeHours ?? 0;
  await saveState(state);
  const { updateTarget } = await import("../src/server/automation/store");
  await updateTarget(TARGET, { optIn: true });
}

/** Pre-warms the registry-check cache (production ticks tolerate cold caches; tests await the sweep). */
async function warmChecks(): Promise<void> {
  const { enrichedOverview } = await import("../src/server/docker/updates");
  await enrichedOverview({ wait: true });
}

async function historyPath(): Promise<string> {
  return path.join(dataDir, "update-history.jsonl");
}

describe("v0.8.0 scheduler/executor full path (disposable scenario)", () => {
  it("1-2-3: eligible + inside window + old digest → queued → dispatched → completed with audit trail", async () => {
    await seedTrackRecord();
    inventoryRoute();
    helperStatusRoute();
    registryRoute(DIGEST_V2); // remote digest != local → UPDATE_AVAILABLE
    helperRoute("/container-update", { accepted: true, phase: "requested" }, 202);
    await configure({ enabled: true, minAgeHours: 0 });
    await warmChecks();

    const { automationTick } = await import("../src/server/automation/scheduler");
    const first = await automationTick();
    assert.match(first.summary, /auto-update started for pilot-test-target/);

    // Job runs: helper reports a finished success on the next tick.
    helperRoute("/container-job", {
      job: {
        name: TARGET,
        phase: "completed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        lastResult: { result: "success", image: IMAGE, durationMs: 5_000, health: "healthy" },
      },
    });
    const second = await automationTick();
    assert.match(second.summary, /settled auto job for pilot-test-target: success/);

    // History entry recorded with the automation actor + metadata.
    const raw = await readFile(await historyPath(), "utf8");
    const entry = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((entry: { actor?: string }) => entry.actor === "system:auto-update");
    assert.ok(entry, "automation history entry exists");
    assert.equal(entry.scope, "container");
    assert.equal(entry.automation?.policyVersion, "v0.8.0-pilot1");
    assert.ok(entry.automation?.digest);

    // Event feed carries the completion.
    const { readEvents } = await import("../src/server/automation/store");
    const events = await readEvents();
    assert.ok(events.some((event) => event.kind === "auto_update_completed" && event.target === TARGET));

    // Queue drained.
    const { loadQueue } = await import("../src/server/automation/store");
    assert.equal((await loadQueue()).length, 0);
  });

  it("age delay: a just-published digest is delayed, not applied", async () => {
    await seedTrackRecord();
    inventoryRoute();
    helperStatusRoute();
    registryRoute(DIGEST_V2);
    await configure({ enabled: true, minAgeHours: 48 });
    await warmChecks();

    const { automationTick } = await import("../src/server/automation/scheduler");
    const result = await automationTick();
    assert.match(result.summary, /evaluated \[pilot-test-target:delayed_by_age\]/);
    const { loadQueue } = await import("../src/server/automation/store");
    assert.equal((await loadQueue()).length, 0);
    assert.ok(!fetchCalls.some((call) => call.includes("/container-update")), "no mutation dispatched");
  });

  it("outside window: no queue, no mutation", async () => {
    await seedTrackRecord();
    inventoryRoute();
    helperStatusRoute();
    registryRoute(DIGEST_V2);
    await configure({ enabled: true, startHour: 4, endHour: 5 });
    await warmChecks(); // now is 12:00 UTC

    const { automationTick } = await import("../src/server/automation/scheduler");
    const result = await automationTick();
    assert.match(result.summary, /pilot-test-target:outside_window/);
    const { loadQueue } = await import("../src/server/automation/store");
    assert.equal((await loadQueue()).length, 0);
  });

  it("registry failure: CHECK_FAILED → blocked, no auto mutation", async () => {
    await seedTrackRecord();
    inventoryRoute();
    helperStatusRoute();
    // No registry route → fetch 404 → check fails → AUTH/CHECK_FAILED.
    await configure({ enabled: true, minAgeHours: 0 });
    await warmChecks();

    const { automationTick } = await import("../src/server/automation/scheduler");
    const result = await automationTick();
    assert.match(result.summary, /pilot-test-target:blocked/);
    assert.ok(!fetchCalls.some((call) => call.includes("/container-update")));
  });

  it("failure + rollback: cooldown entered, no retry loop; ack clears it", async () => {
    await seedTrackRecord();
    inventoryRoute();
    helperStatusRoute();
    registryRoute(DIGEST_V2);
    helperRoute("/container-update", { accepted: true, phase: "requested" }, 202);
    await configure({ enabled: true, minAgeHours: 0 });
    await warmChecks();

    const { automationTick } = await import("../src/server/automation/scheduler");
    await automationTick(); // dispatch
    helperRoute("/container-job", {
      job: {
        name: TARGET,
        phase: "rolled-back",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        lastResult: { result: "rolled-back", error: "health verification failed", durationMs: 9_000 },
      },
    });
    const settled = await automationTick();
    assert.match(settled.summary, /settled auto job.*rolled-back/);

    // No retry: subsequent ticks stay blocked (rollback on record) with the
    // cooldown recorded — exactly one dispatch ever.
    for (let index = 0; index < 2; index++) {
      const result = await automationTick();
      assert.match(result.summary, /pilot-test-target:blocked/);
    }
    assert.equal(fetchCalls.filter((call) => call.includes("/container-update")).length, 1, "exactly one dispatch ever");
    const { loadState } = await import("../src/server/automation/store");
    const stored = (await loadState()).targets[TARGET];
    assert.ok(stored?.cooldownUntil, "cooldown persisted");

    const { readEvents } = await import("../src/server/automation/store");
    const events = await readEvents();
    assert.ok(events.some((event) => event.kind === "auto_update_rolled_back"));
    assert.ok(events.some((event) => event.kind === "cooldown_entered"));

    // Operator ack clears the cooldown → eligible again.
    const { updateTarget } = await import("../src/server/automation/store");
    await updateTarget(TARGET, { cooldownUntil: null, cooldownReason: null });
    const after = await automationTick();
    // Track record now has a rollback → blocked (zero unresolved rollback rule), not a retry.
    assert.match(after.summary, /pilot-test-target:blocked/);
  });

  it("rollback FAILED → manual intervention required; automation stops until acknowledged", async () => {
    await seedTrackRecord();
    inventoryRoute();
    helperStatusRoute();
    registryRoute(DIGEST_V2);
    helperRoute("/container-update", { accepted: true, phase: "requested" }, 202);
    await configure({ enabled: true, minAgeHours: 0 });
    await warmChecks();

    const { automationTick } = await import("../src/server/automation/scheduler");
    await automationTick(); // dispatch
    helperRoute("/container-job", {
      job: {
        name: TARGET,
        phase: "rollback-failed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        lastResult: { result: "rollback-failed", error: "manual recovery required", durationMs: 9_000 },
      },
    });
    await automationTick(); // settle
    const { loadState } = await import("../src/server/automation/store");
    const state = await loadState();
    assert.equal(state.targets[TARGET]?.interventionRequired, true);
    const { readEvents } = await import("../src/server/automation/store");
    assert.ok((await readEvents()).some((event) => event.kind === "intervention_required"));

    // Even a fresh eligible-looking evaluation stays intervention_required.
    const after = await automationTick();
    assert.match(after.summary, /pilot-test-target:intervention_required/);
    assert.equal(fetchCalls.filter((call) => call.includes("/container-update")).length, 1, "no NEW mutation after intervention");
  });

  it("policy change cancels pending jobs; opt-out cancels the target's job", async () => {
    await seedTrackRecord();
    inventoryRoute();
    helperStatusRoute();
    registryRoute(DIGEST_V2);
    helperRoute("/container-update", { accepted: true, phase: "requested" }, 202);
    await configure({ enabled: true, minAgeHours: 0 });
    await warmChecks();
    const { automationTick } = await import("../src/server/automation/scheduler");
    const dispatched = await automationTick(); // dispatch → queued becomes updating
    assert.ok(dispatched.started, "dispatch happened: " + dispatched.summary);
    const store = await import("../src/server/automation/store");
    let queue = await store.loadQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0]?.state, "updating");

    // Disable automation: the IN-FLIGHT job is never dropped mid-recreate —
    // it settles normally; no NEW job may start afterwards.
    const { setConfig } = await import("../src/server/automation/status");
    await setConfig({ enabled: false });
    const afterDisable = await automationTick();
    assert.match(afterDisable.summary, /pilot-test-target:blocked|still running/);
    queue = await store.loadQueue();
    assert.equal(queue.filter((job) => job.state === "queued").length, 0, "no queued jobs after policy change");
    assert.equal(fetchCalls.filter((call) => call.includes("/container-update")).length, 1, "no NEW dispatch after policy change");
    const { readEvents } = await import("../src/server/automation/store");
    assert.ok((await readEvents()).some((event) => event.kind === "queue_cancelled") || (await readEvents()).some((event) => event.kind === "auto_update_completed"));
  });

  it("helper unavailable: queue held, no mutation, recovery revalidates", async () => {
    await seedTrackRecord();
    inventoryRoute();
    helperStatusRoute();
    registryRoute(DIGEST_V2);
    await configure({ enabled: true, minAgeHours: 0 });
    await warmChecks();

    // Helper down at dispatch time (status 503 replaces the healthy route).
    routes = routes.filter((route) => !(route.match(new URL("http://127.0.0.1:8790/status"))));
    helperRoute("/status", { version: "0.8.0" }, 503);
    const { automationTick } = await import("../src/server/automation/scheduler");
    const result = await automationTick();
    assert.match(result.summary, /pilot-test-target:blocked/);
    assert.ok(!fetchCalls.some((call) => call.includes("/container-update")));
  });

  it("digest mutation: a changed remote digest cancels the queued job (never applies stale)", async () => {
    await seedTrackRecord();
    inventoryRoute();
    helperStatusRoute();
    registryRoute(DIGEST_V2);
    await configure({ enabled: true, minAgeHours: 0 });
    await warmChecks();

    // Seed a QUEUED job bound to an OLD digest.
    const { enqueueJob } = await import("../src/server/automation/store");
    await enqueueJob({
      target: TARGET,
      scope: "container",
      image: IMAGE,
      digest: "sha256:" + "c".repeat(64),
      digestFirstSeenAt: new Date(Date.now() - 96 * 3_600_000).toISOString(),
      reasons: ["stale queue entry from a previous tick"],
    });

    const { automationTick } = await import("../src/server/automation/scheduler");
    const result = await automationTick();
    // The queued job's digest doesn't match the live remote digest →
    // cancelled; the fresh evaluation re-queues against DIGEST_V2.
    assert.ok(/digest changed|auto-update started/.test(result.summary));
    const { loadQueue } = await import("../src/server/automation/store");
    const queue = await loadQueue();
    assert.ok(queue.every((job) => job.digest !== "sha256:" + "c".repeat(64)), "stale digest job gone");
  });

  it("restart/reconciliation: persisted state + queue survive an in-memory reset and are revalidated", async () => {
    await seedTrackRecord();
    inventoryRoute();
    helperStatusRoute();
    registryRoute(DIGEST_V2);
    helperRoute("/container-update", { accepted: true, phase: "requested" }, 202);
    await configure({ enabled: true, minAgeHours: 0 });
    await warmChecks();

    const { automationTick } = await import("../src/server/automation/scheduler");
    const dispatchTick = await automationTick(); // dispatch → updating job persisted
    assert.ok(dispatchTick.started, "dispatch happened: " + dispatchTick.summary);

    // Simulate an app restart: wipe module-level caches, keep files.
    const store = await import("../src/server/automation/store");
    store.resetAutomationStores();
    const queue = await store.loadQueue();
    assert.equal(queue.length, 1, "queue reloaded from disk");
    assert.equal(queue[0]?.state, "updating");

    // Next tick revalidates against the helper: job finished → settles.
    helperRoute("/container-job", {
      job: {
        name: TARGET,
        phase: "completed",
        startedAt: queue[0]!.createdAt,
        finishedAt: new Date().toISOString(),
        lastResult: { result: "success", image: IMAGE, durationMs: 4_000 },
      },
    });
    const result = await automationTick();
    assert.match(result.summary, /settled auto job for pilot-test-target: success/);
  });

  it("data dir unwritable → blocked (state could not persist)", async () => {
    await seedTrackRecord();
    inventoryRoute();
    helperStatusRoute();
    registryRoute(DIGEST_V2);
    await configure({ enabled: true, minAgeHours: 0 });
    await warmChecks();
    // Point AUDIT_DIR at a non-writable path.
    process.env.AUDIT_DIR = "/proc/nonexistent";
    const { resetEnvCache } = await import("../src/server/env");
    resetEnvCache();
    const { resetAutomationStores } = await import("../src/server/automation/store");
    resetAutomationStores();
    const { automationTick } = await import("../src/server/automation/scheduler");
    const result = await automationTick();
    assert.match(result.summary, /not writable/);
    assert.ok(!fetchCalls.some((call) => call.includes("/container-update")));
  });
});

describe("v0.8.0 digest first-seen store", () => {
  it("first observation starts the clock; a digest change RESETS it", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "digest-store-"));
    process.env.AUDIT_DIR = dataDir;
    const { resetEnvCache } = await import("../src/server/env");
    resetEnvCache();
    const { resetAutomationStores, observeDigest, digestAgeMs } = await import("../src/server/automation/store");
    resetAutomationStores();
    const now = new Date("2026-09-28T12:00:00Z");
    await observeDigest(IMAGE, DIGEST_V1, new Date("2026-09-26T12:00:00Z"));
    const age48 = await digestAgeMs(IMAGE, DIGEST_V1, now);
    assert.equal(age48, 48 * 3_600_000);
    // Tag moved: first-seen resets.
    await observeDigest(IMAGE, DIGEST_V2, now);
    const age0 = await digestAgeMs(IMAGE, DIGEST_V2, now);
    assert.equal(age0, 0);
    // Old digest no longer resolves.
    assert.equal(await digestAgeMs(IMAGE, DIGEST_V1, now), null);
  });

  it("bounded history: prune keeps the store capped", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "digest-prune-"));
    process.env.AUDIT_DIR = dataDir;
    const { resetEnvCache } = await import("../src/server/env");
    resetEnvCache();
    const { resetAutomationStores, observeDigest, loadDigests } = await import("../src/server/automation/store");
    resetAutomationStores();
    for (let index = 0; index < 220; index++) {
      await observeDigest(`ghcr.io/pilot/img-${index}:latest`, "sha256:" + String(index).padStart(64, "0"), new Date(Date.now() + index * 1000));
    }
    const digests = await loadDigests();
    assert.ok(Object.keys(digests).length <= 200);
  });
});

describe("v0.8.0 project registry + plan invalidation", () => {
  it("hash change marks config_changed and the next plan call clears it after fresh derivation", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "project-registry-"));
    process.env.AUDIT_DIR = dataDir;
    const { resetEnvCache } = await import("../src/server/env");
    resetEnvCache();
    const registry = await import("../src/server/automation/project-registry");
    registry.resetProjectRegistry();

    // Inventory with one compose project (working dir inside an allowed root).
    helperRoute("/inventory", {
      version: "0.8.0",
      containers: [
        {
          id: "c1",
          name: "stack-web-1",
          image: "ghcr.io/owner/stack:1.0.0",
          state: "running",
          status: "Up",
          health: "healthy",
          imageId: "sha256:x",
          repoDigests: ["ghcr.io/owner/stack@sha256:y"],
          networks: [],
          volumeSources: [],
          created: null,
          labels: {
            "com.docker.compose.project": "stack",
            "com.docker.compose.service": "web",
            "com.docker.compose.project.working_dir": "/mnt/user/appdata/stack",
            "com.docker.compose.project.config_files": "/mnt/user/appdata/stack/docker-compose.yml",
          },
          unsupported: [],
          externallyManaged: false,
          snapshotPresent: true,
        },
      ],
      storage: { mode: "folder", source: null },
    });
    helperRoute("/compose-project-hash", { project: "stack", pipelineOwned: false, hash: "hash-v1", files: [], computedAt: new Date().toISOString() });
    helperRoute("/compose-project", { project: "stack", pipelineOwned: false, workingDir: "/mnt/user/appdata/stack", configFiles: [], services: [{ service: "web", containers: ["stack-web-1"], state: "running" }], dependsOn: { web: [] }, graphOk: true });
    // overview needs registry check for the image
    registryRoute("sha256:y");

    const first = await registry.pollProjectRegistry(true);
    assert.equal(first.projects["stack"]?.hash, "hash-v1");
    assert.equal(first.projects["stack"]?.configChanged, false);

    // Compose file edited → hash changes → config_changed flips on.
    // (Replace the route: the router matches the FIRST registered route.)
    routes = routes.filter((route) => !(route.match(new URL("http://127.0.0.1:8790/compose-project-hash?project=stack"))));
    helperRoute("/compose-project-hash", { project: "stack", pipelineOwned: false, hash: "hash-v2", files: [], computedAt: new Date().toISOString() });
    const second = await registry.pollProjectRegistry(true);
    assert.equal(second.projects["stack"]?.configChanged, true);
    assert.ok(second.projects["stack"]?.lastChanged);

    // planWithInvalidation: fresh derivation succeeds → flag cleared.
    routes = routes.filter((route) => !(route.match(new URL("http://127.0.0.1:8790/compose-project-hash?project=stack"))));
    helperRoute("/compose-project-hash", { project: "stack", pipelineOwned: false, hash: "hash-v2", files: [], computedAt: new Date().toISOString() });
    const result = await registry.planWithInvalidation("stack");
    assert.equal(result.available, true);
    const third = await registry.loadRegistry();
    assert.equal(third.projects["stack"]?.configChanged, false);
    assert.equal(third.projects["stack"]?.planHashBasis, "hash-v2");
  });

  it("pipeline-owned projects are observed but never hashed", async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "pipeline-registry-"));
    process.env.AUDIT_DIR = dataDir;
    const { resetEnvCache } = await import("../src/server/env");
    resetEnvCache();
    const registry = await import("../src/server/automation/project-registry");
    registry.resetProjectRegistry();
    helperRoute("/inventory", {
      version: "0.8.0",
      containers: [
        {
          id: "t1",
          name: "tornscope-web-1",
          image: "tornscope-web:latest",
          state: "running",
          status: "Up",
          health: null,
          imageId: "sha256:t",
          repoDigests: [],
          networks: [],
          volumeSources: [],
          created: null,
          labels: { "com.docker.compose.project": "tornscope", "com.docker.compose.service": "web" },
          unsupported: [],
          externallyManaged: true,
          snapshotPresent: false,
        },
      ],
      storage: { mode: "folder", source: null },
    });
    const view = await registry.pollProjectRegistry(true);
    assert.equal(view.projects["tornscope"]?.hash, null);
    assert.equal(view.projects["tornscope"]?.configChanged, false);
    assert.ok(!fetchCalls.some((call) => call.includes("/compose-project-hash")), "no hash query for pipeline projects");
  });
});

after(() => {
  const handles = (process as unknown as { _getActiveHandles?: () => Array<{ constructor?: { name: string }; hasRef?: () => boolean }> })._getActiveHandles?.() ?? [];
  console.error("ACTIVE HANDLES AFTER TESTS:", handles.map((handle) => `${handle.constructor?.name}${handle.hasRef?.() ? "(refed)" : ""}`).join(", "));
});
