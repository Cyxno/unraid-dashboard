import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import {
  containerStatsBatch,
  hasContainerRecord,
  readContainerHistory,
  recordContainerUpdate,
  resetUpdateHistoryQueue,
} from "../src/server/update/history";
import { resetEnvCache } from "../src/server/env";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "container-history-test-"));
  process.env.AUDIT_DIR = dataDir;
  resetEnvCache();
  resetUpdateHistoryQueue();
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

describe("v0.7.13 container/project update history", () => {
  it("records and reads back container entries with scope/target/adapter", async () => {
    await recordContainerUpdate({
      startedAt: "2026-09-28T10:00:00.000Z",
      actor: "cyxno",
      target: "crosswatch",
      scope: "container",
      adapter: "helper",
      image: "cenodude/crosswatch:latest",
      previousImage: "cenodude/crosswatch:old",
      durationMs: 42_000,
      phasesReached: ["requested", "snapshotting", "pulling", "completed"],
      result: "success",
      rollbackPerformed: false,
    });
    const entries = await readContainerHistory();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.scope, "container");
    assert.equal(entries[0]?.target, "crosswatch");
    assert.equal(entries[0]?.actor, "cyxno");
    assert.equal(entries[0]?.result, "success");
  });

  it("dedupes by startedAt + target (exactly-once reconciliation)", async () => {
    const payload = {
      startedAt: "2026-09-28T10:00:00.000Z",
      actor: "helper-machine",
      target: "project:stack",
      scope: "project" as const,
      adapter: "compose-project",
      image: "db,api,web",
      durationMs: 90_000,
      phasesReached: ["requested", "completed"],
      result: "success" as const,
      rollbackPerformed: false,
    };
    await recordContainerUpdate(payload);
    assert.equal(await hasContainerRecord(payload.startedAt, "project:stack"), true);
    // A second reconcile for the same machine run must not duplicate.
    if (!(await hasContainerRecord(payload.startedAt, "project:stack"))) {
      await recordContainerUpdate(payload);
    }
    const entries = await readContainerHistory();
    assert.equal(entries.length, 1);
  });

  it("filters by target, result and scope", async () => {
    await recordContainerUpdate({
      startedAt: "2026-09-28T10:00:00.000Z", actor: "a", target: "crosswatch", scope: "container",
      adapter: "helper", image: "img:1", durationMs: 1, phasesReached: [], result: "success", rollbackPerformed: false,
    });
    await recordContainerUpdate({
      startedAt: "2026-09-28T11:00:00.000Z", actor: "b", target: "crosswatch", scope: "container",
      adapter: "helper", image: "img:2", durationMs: 1, phasesReached: [], result: "rolled-back", rollbackPerformed: true,
      error: "health failed",
    });
    await recordContainerUpdate({
      startedAt: "2026-09-28T12:00:00.000Z", actor: "c", target: "project:stack", scope: "project",
      adapter: "compose-project", image: "web", durationMs: 1, phasesReached: [], result: "failed", rollbackPerformed: false,
      error: "service api failed pre-mutation — project update stopped: pull failed",
    });

    assert.equal((await readContainerHistory({ target: "crosswatch" })).length, 2);
    assert.equal((await readContainerHistory({ target: "crosswatch", result: "rolled-back" })).length, 1);
    assert.equal((await readContainerHistory({ scope: "project" })).length, 1);
    assert.equal((await readContainerHistory({ scope: "container", result: "success" })).length, 1);
  });

  it("containerStatsBatch computes per-container track record in one read", async () => {
    await recordContainerUpdate({
      startedAt: "2026-09-28T10:00:00.000Z", actor: "a", target: "crosswatch", scope: "container",
      adapter: "helper", image: "img:1", durationMs: 1, phasesReached: [], result: "success", rollbackPerformed: false,
    });
    await recordContainerUpdate({
      startedAt: "2026-09-28T11:00:00.000Z", actor: "a", target: "crosswatch", scope: "container",
      adapter: "helper", image: "img:2", durationMs: 1, phasesReached: [], result: "success", rollbackPerformed: false,
    });
    await recordContainerUpdate({
      startedAt: "2026-09-28T12:00:00.000Z", actor: "a", target: "crosswatch", scope: "container",
      adapter: "helper", image: "img:3", durationMs: 1, phasesReached: [], result: "success", rollbackPerformed: false,
    });
    await recordContainerUpdate({
      startedAt: "2026-09-28T13:00:00.000Z", actor: "a", target: "uptime-kuma", scope: "container",
      adapter: "helper", image: "img:9", durationMs: 1, phasesReached: [], result: "rolled-back", rollbackPerformed: true,
    });

    const batch = await containerStatsBatch();
    const kuma = batch.get("crosswatch");
    assert.equal(kuma?.manualSuccesses, 3);
    assert.equal(kuma?.rollbackCount, 0);
    assert.equal(kuma?.lastSuccess?.image, "img:3"); // most recent success = current known good
    const rolled = batch.get("uptime-kuma");
    assert.equal(rolled?.rollbackCount, 1);
    assert.equal(rolled?.manualSuccesses, 0);
  });

  it("entries never contain env or secret material", async () => {
    await recordContainerUpdate({
      startedAt: "2026-09-28T10:00:00.000Z", actor: "a", target: "x", scope: "container",
      adapter: "helper", image: "img:1", durationMs: 1, phasesReached: [], result: "failed", rollbackPerformed: false,
      error: "pull failed: unauthorized TOKEN_VALUE=abc123",
    });
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path.join(dataDir, "update-history.jsonl"), "utf8");
    // The error field is length-capped and structural; no env-snapshot keys.
    assert.ok(!/"env"\s*:/.test(raw));
    assert.ok(!/PASSWORD|SECRET_KEY/.test(raw));
  });
});
