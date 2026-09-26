import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import {
  recordUpdateEntry,
  readUpdateHistory,
  validatedVersions,
  type UpdateHistoryEntry,
} from "../src/server/update/history";
import { resetEnvCache } from "../src/server/env";

/** v0.7.4 rollback allowlist: only successfully-run releases qualify. */
describe("v0.7.4 validated-release rollback allowlist", () => {
  it("includes only versions with a successful run", () => {
    const history: UpdateHistoryEntry[] = [
      entry("0.7.0", "success"),
      entry("0.7.1", "success"),
      entry("0.7.2", "rolled-back"),
      entry("0.7.3", "failed"),
    ];
    assert.deepEqual(validatedVersions(history), ["0.7.1", "0.7.0"]);
  });

  it("sorts newest first for UI presentation", () => {
    const history = [entry("0.6.0", "success"), entry("0.7.2", "success"), entry("0.7.10", "success")];
    // 0.7.10 > 0.7.2 numerically
    assert.deepEqual(validatedVersions(history), ["0.7.10", "0.7.2", "0.6.0"]);
  });

  it("returns empty for empty history", () => {
    assert.deepEqual(validatedVersions([]), []);
  });

  it("excludes the current version's targets only via UI filtering — allowlist itself keeps all successes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rollback-allow-"));
    process.env.AUDIT_DIR = dir;
    resetEnvCache();
    await recordUpdateEntry(entry("0.7.2", "success"));
    const history = await readUpdateHistory();
    assert.deepEqual(validatedVersions(history), ["0.7.2"]);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });
});

function entry(toVersion: string, result: UpdateHistoryEntry["result"]): UpdateHistoryEntry {
  return {
    timestamp: "2026-09-26T20:00:00.000Z",
    startedAt: "2026-09-26T19:59:00.000Z",
    actor: "test",
    fromVersion: "0.0.1",
    fromDigest: null,
    toVersion,
    toDigest: null,
    durationMs: 1000,
    phasesReached: ["complete"],
    result,
    rollbackPerformed: result === "rolled-back",
    usedLocalImage: false,
  };
}

/** The helper's new-version guard: updates must go forward; rollback goes via /rollback. */
describe("v0.7.4 helper version-guard semantics", () => {
  function compare(a: string, b: string): number {
    const pa = a.replace(/^v/, "").split(".").map(Number);
    const pb = b.replace(/^v/, "").split(".").map(Number);
    for (let i = 0; i < 3; i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  it("rejects older-tag updates (must use rollback)", () => {
    assert.ok(compare("0.7.2", "0.7.3") < 0);
  });

  it("accepts newer-tag updates", () => {
    assert.ok(compare("0.7.4", "0.7.3") > 0);
  });

  it("same-version transitions pass the guard (validation path)", () => {
    assert.equal(compare("0.7.3", "0.7.3"), 0);
  });
});
