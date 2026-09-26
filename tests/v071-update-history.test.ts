import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import {
  maybeRecordFromHelper,
  readUpdateHistory,
  recordUpdateEntry,
  resetUpdateHistoryQueue,
  setPendingUpdateRequest,
  type UpdateHistoryEntry,
} from "../src/server/update/history";
import type { UpdateHelperStatus } from "../src/server/update/helper-client";
import { resetEnvCache } from "../src/server/env";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "update-history-test-"));
  process.env.AUDIT_DIR = dataDir;
  resetEnvCache();
  resetUpdateHistoryQueue();
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

function helperWithLastUpdate(
  last: UpdateHelperStatus["lastUpdate"],
  log: Array<{ at: string; phase: string; detail: string }> = [],
): UpdateHelperStatus {
  return {
    configured: true,
    reachable: true,
    reason: null,
    helperVersion: "0.7.1",
    phase: "idle",
    detail: null,
    startedAt: null,
    finishedAt: null,
    log,
    lock: null,
    lastUpdate: last,
    currentImage: "ghcr.io/cyxno/unraid-dashboard:0.7.0",
    currentVersion: "0.7.0",
    currentRevision: null,
    currentImageId: "sha256:abc",
    localVersions: ["0.7.0"],
    pullAvailable: false,
  };
}

describe("v0.7.1 update history persistence", () => {
  it("reconciles a helper lastUpdate into the history file", async () => {
    const result = await maybeRecordFromHelper(
      helperWithLastUpdate({
        from: "ghcr.io/cyxno/unraid-dashboard:0.7.0",
        to: "ghcr.io/cyxno/unraid-dashboard:0.7.1",
        result: "success",
        startedAt: "2026-09-26T18:00:00.000Z",
        finishedAt: "2026-09-26T18:00:20.000Z",
        durationMs: 20_000,
        usedLocalImage: true,
      }),
    );
    assert.equal(result.recorded, true);
    const history = await readUpdateHistory();
    assert.equal(history.length, 1);
    const entry = history[0]!;
    assert.equal(entry.fromVersion, "0.7.0");
    assert.equal(entry.toVersion, "0.7.1");
    assert.equal(entry.result, "success");
    assert.equal(entry.usedLocalImage, true);
    assert.equal(entry.actor, "helper-machine");
  });

  it("does not duplicate the same machine run (dedupe by startedAt+toVersion)", async () => {
    const helper = helperWithLastUpdate({
      from: "ghcr.io/cyxno/unraid-dashboard:0.7.0",
      to: "ghcr.io/cyxno/unraid-dashboard:0.7.1",
      result: "success",
      startedAt: "2026-09-26T18:00:00.000Z",
      finishedAt: "2026-09-26T18:00:20.000Z",
      durationMs: 20_000,
    });
    await maybeRecordFromHelper(helper);
    const second = await maybeRecordFromHelper(helper);
    assert.equal(second.recorded, false);
    const history = await readUpdateHistory();
    assert.equal(history.length, 1);
  });

  it("attributes the real actor via the pending request handoff", async () => {
    setPendingUpdateRequest("0.7.1", "remco");
    await maybeRecordFromHelper(
      helperWithLastUpdate({
        from: "ghcr.io/cyxno/unraid-dashboard:0.7.0",
        to: "ghcr.io/cyxno/unraid-dashboard:0.7.1",
        result: "success",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 5_000,
      }),
    );
    const history = await readUpdateHistory();
    assert.equal(history[0]?.actor, "remco");
  });

  it("records rollback results with the flag", async () => {
    await maybeRecordFromHelper(
      helperWithLastUpdate({
        from: "ghcr.io/cyxno/unraid-dashboard:0.7.1",
        to: "ghcr.io/cyxno/unraid-dashboard:0.7.2",
        result: "rolled-back",
        startedAt: "2026-09-26T18:10:00.000Z",
        finishedAt: "2026-09-26T18:12:00.000Z",
        durationMs: 120_000,
        error: "container did not become healthy in time",
      }),
    );
    const history = await readUpdateHistory();
    assert.equal(history[0]?.result, "rolled-back");
    assert.equal(history[0]?.rollbackPerformed, true);
    assert.match(history[0]?.error ?? "", /healthy/);
  });

  it("collects the phases the machine reached from its log", async () => {
    await maybeRecordFromHelper(
      helperWithLastUpdate(
        {
          from: "ghcr.io/cyxno/unraid-dashboard:0.7.0",
          to: "ghcr.io/cyxno/unraid-dashboard:0.7.1",
          result: "success",
          startedAt: "2026-09-26T18:00:00.000Z",
          finishedAt: "2026-09-26T18:00:20.000Z",
          durationMs: 20_000,
        },
        [
          { at: "t1", phase: "checking", detail: "" },
          { at: "t2", phase: "pulling", detail: "" },
          { at: "t", phase: "replacing", detail: "" },
          { at: "t", phase: "healthchecking", detail: "" },
          { at: "t", phase: "verifying", detail: "" },
          { at: "t", phase: "complete", detail: "" },
        ],
      ),
    );
    const history = await readUpdateHistory();
    assert.deepEqual(history[0]?.phasesReached, [
      "checking",
      "pulling",
      "replacing",
      "healthchecking",
      "verifying",
      "complete",
    ]);
  });

  it("skips machines without completion and empty files read as []", async () => {
    assert.deepEqual(await readUpdateHistory(), []);
    const skip = await maybeRecordFromHelper(helperWithLastUpdate(null));
    assert.equal(skip.recorded, false);
    assert.deepEqual(await readUpdateHistory(), []);
  });

  it("round-trips explicit entries (newest first) and persists to disk", async () => {
    const entry: UpdateHistoryEntry = {
      timestamp: "2026-09-26T19:00:00.000Z",
      startedAt: "2026-09-26T18:59:00.000Z",
      actor: "remco",
      fromVersion: "0.7.0",
      fromDigest: null,
      toVersion: "0.7.1",
      toDigest: null,
      durationMs: 30_000,
      phasesReached: ["complete"],
      result: "success",
      rollbackPerformed: false,
      usedLocalImage: false,
    };
    await recordUpdateEntry(entry);
    const history = await readUpdateHistory();
    assert.equal(history.length, 1);
    const raw = await readFile(path.join(dataDir, "update-history.jsonl"), "utf8");
    assert.match(raw, /"actor":"remco"/);
    assert.ok(!raw.includes("token"), "no secret material in history");
  });
});

describe("v0.7.1 local-image release discovery logic", () => {
  // The discovery decision mirrors src/app/api/update/status/route.ts.
  function discover(localVersions: string[], runningVersion: string): { status: string; latestTag: string | null } {
    const newestLocal = localVersions[0] ?? null;
    if (!newestLocal) return { status: "unknown", latestTag: null };
    const parse = (v: string) => v.split(".").map(Number);
    const pa = parse(newestLocal);
    const pb = parse(runningVersion);
    let comparison = 0;
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) { comparison = (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1; break; }
    }
    return {
      status: comparison > 0 ? "available" : comparison === 0 ? "up-to-date" : "unknown",
      latestTag: comparison > 0 ? newestLocal : runningVersion,
    };
  }

  it("discovers a newer local image as available", () => {
    assert.deepEqual(discover(["0.7.1", "0.7.0"], "0.7.0"), { status: "available", latestTag: "0.7.1" });
  });

  it("reports up-to-date when only the running version is local", () => {
    assert.deepEqual(discover(["0.7.0"], "0.7.0"), { status: "up-to-date", latestTag: "0.7.0" });
  });

  it("reports unknown when local is older than running", () => {
    assert.equal(discover(["0.6.0"], "0.7.0").status, "unknown");
  });

  it("handles empty local lists", () => {
    assert.equal(discover([], "0.7.0").status, "unknown");
  });
});
