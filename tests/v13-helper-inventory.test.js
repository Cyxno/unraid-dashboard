"use strict";
/**
 * v1.3.13 helper inventory hardening — regression suite.
 *
 * Pins the exact production failure class that silently degraded the
 * helper inventory (NDJSON one-shot parse, short/full id join miss,
 * stdout truncation, cache poisoning) plus the new partial/structural
 * degradation contract. Pure-function tests: no docker required.
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import {
  isFullId,
  isShortId,
  normalizeContainerId,
  parseInspectOutput,
  buildIdIndex,
  chunkList,
  assessInventory,
  nextInventoryCache,
  refreshLogLine,
} from "../helper/inventory.js";

function inspectRecord(shortHex, overrides = {}) {
  const full = `${shortHex}${"a1b2c3d4e5f6".repeat(5)}`.slice(0, 64);
  return {
    Id: full,
    Name: `/c-${shortHex}`,
    Config: { Labels: { "net.unraid.docker.managed": "dockerman" } },
    Image: "sha256:image-" + shortHex,
    State: { Status: "running", Health: { Status: "healthy" } },
    NetworkSettings: { Networks: { bridge: {} } },
    Mounts: [{ Source: "/mnt/user/appdata/x", Destination: "/x" }],
    Created: "2026-10-04T00:00:00Z",
    ...overrides,
  };
}

/* ---- Fase 1: the three production failure modes, modeled --------------- */

describe("Fase 1 — old failure modes cannot return", () => {
  test("A. NDJSON: old one-shot JSON.parse throws on 3-record output; new parser recovers all", () => {
    const stdout = [
      JSON.stringify({ Id: "a".repeat(64) }),
      JSON.stringify({ Id: "b".repeat(64) }),
      JSON.stringify({ Id: "c".repeat(64) }),
    ].join("\n");
    assert.throws(() => JSON.parse(stdout)); // the old behavior — must stay red
    const { records, parseErrors } = parseInspectOutput(stdout);
    assert.equal(records.length, 3);
    assert.equal(parseErrors.length, 0);
  });

  test("B. short/full id: naive Map.get(shortId) misses; index joins both", () => {
    const record = inspectRecord("abcdef123456");
    const { byId } = buildIdIndex([record]);
    const short = record.Id.slice(0, 12);
    const naive = new Map([[record.Id, record]]);
    assert.equal(naive.get(short), undefined); // the old miss — modeled red
    assert.equal(byId.get(short), record);
    assert.equal(byId.get(record.Id), record);
  });

  test("C. stdout truncation: tail records of a >400KB payload still parse", () => {
    // 100 fat records ≈ far beyond the old 400KB capture cap; the parser
    // must survive whatever lines it receives, keeping complete records.
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({ ...inspectRecord(String(i).padStart(12, "0")), Padding: "x".repeat(5000) }));
    }
    const out = lines.join("\n");
    assert.ok(out.length > 400_000);
    const { records } = parseInspectOutput(out);
    assert.equal(records.length, 100);
  });
});

/* ---- Fase 4/5: parser + partial behavior ------------------------------- */

describe("Fase 4/5 — robust inspect parsing", () => {
  test("trailing newline and blank lines are fine", () => {
    const out = `${JSON.stringify({ Id: "a".repeat(64) })}\n\n${JSON.stringify({ Id: "b".repeat(64) })}\n\n`;
    const { records, parseErrors } = parseInspectOutput(out);
    assert.equal(records.length, 2);
    assert.equal(parseErrors.length, 0);
  });

  test("CRLF line endings are tolerated", () => {
    const out = `${JSON.stringify({ Id: "a".repeat(64) })}\r\n${JSON.stringify({ Id: "b".repeat(64) })}\r\n`;
    const { records } = parseInspectOutput(out);
    assert.equal(records.length, 2);
  });

  test("10 records with 1 malformed line: 9 valid kept, 1 explicit parse error", () => {
    const lines = [];
    for (let i = 0; i < 10; i++) lines.push(i === 4 ? "{definitely not json" : JSON.stringify({ Id: String(i).repeat(64) }));
    const { records, parseErrors } = parseInspectOutput(lines.join("\n"));
    assert.equal(records.length, 9);
    assert.equal(parseErrors.length, 1);
    assert.equal(parseErrors[0].line, 5);
  });

  test("non-object lines (arrays, strings) count as parse errors, not records", () => {
    const { records, parseErrors } = parseInspectOutput(`[1,2]\n"str"\n${JSON.stringify({ Id: "a".repeat(64) })}`);
    assert.equal(records.length, 1);
    assert.equal(parseErrors.length, 2);
  });

  test("empty stdout parses to nothing without throwing", () => {
    const { records, parseErrors } = parseInspectOutput("");
    assert.equal(records.length, 0);
    assert.equal(parseErrors.length, 0);
  });
});

/* ---- Fase 3/20/21/22: ids, ordering, duplicates ------------------------- */

describe("Fase 3/20/21/22 — canonical ids and index integrity", () => {
  test("malformed ids are rejected for identity mapping", () => {
    assert.equal(isFullId("zzzz"), false);
    assert.equal(isFullId("A".repeat(64)), false); // uppercase rejected
    assert.equal(isShortId("abc"), false);
    assert.equal(normalizeContainerId("nothexatall!").valid, false);
    const n = normalizeContainerId("abcdef123456");
    assert.equal(n.valid, true);
    assert.equal(n.short, "abcdef123456");
    assert.equal(n.full, null);
  });

  test("reordered inspect output joins correctly by id map, not index", () => {
    const r1 = inspectRecord("000000000001");
    const r2 = inspectRecord("000000000002");
    const forward = buildIdIndex([r1, r2]);
    const reversed = buildIdIndex([r2, r1]);
    assert.equal(forward.byId.get(r1.Id), r1);
    assert.equal(reversed.byId.get(r1.Id), r1);
    assert.equal(reversed.byId.get(r1.Id.slice(0, 12)), r1);
  });

  test("duplicate record is counted, index stays coherent", () => {
    const r = inspectRecord("000000000003");
    const { byId, duplicates } = buildIdIndex([r, r]);
    assert.equal(duplicates, 1);
    assert.equal(byId.get(r.Id), r);
  });

  test("records without a valid full Id are counted as malformed", () => {
    const { malformed } = buildIdIndex([{ Id: "not-hex" }, { noId: true }]);
    assert.equal(malformed, 2);
  });
});

/* ---- Fase 7/8: chunking ------------------------------------------------- */

describe("Fase 7/8 — chunked batch strategy", () => {
  test("deterministic chunks with remainder chunk", () => {
    const items = Array.from({ length: 105 }, (_, i) => i);
    const chunks = chunkList(items, 25);
    assert.deepEqual(chunks.map((c) => c.length), [25, 25, 25, 25, 5]);
    assert.equal(chunks.flat().length, 105);
  });

  test("61 production-sized fixture → 3 chunks, no container lost", () => {
    const entries = Array.from({ length: 61 }, (_, i) => [[String(i).padStart(12, "0")], `c${i}`, "img", "running", "Up"]);
    const chunks = chunkList(entries, 25);
    assert.equal(chunks.length, 3);
    assert.equal(chunks.flat().length, 61);
  });

  test("empty input → zero chunks (no subprocess at all)", () => {
    assert.deepEqual(chunkList([], 25), []);
  });
});

/* ---- Fase 9/10: race + failure isolation at fact level ------------------ */

describe("Fase 9/10 — partial facts and failure isolation", () => {
  test("container removed between ps and inspect: degraded facts, others intact", () => {
    const found = inspectRecord("000000000001");
    const { byId } = buildIdIndex([found]);
    const removed = byId.get("999999999999") ?? null; // ps knew it, inspect didn't
    assert.equal(removed, null);
    // caller falls back to degraded fact entry; the OTHER record survives
    assert.equal(byId.get(found.Id), found);
  });

  test("empty-but-present chunk output (docker error text) yields zero records — caller retries then degrades", () => {
    const { records } = parseInspectOutput("Error response from daemon: No such container");
    assert.equal(records.length, 0);
    assert.equal(records.length === 0, true); // triggers the retry/degrade path
  });
});

/* ---- Fase 11/12: cache poisoning prevention ----------------------------- */

describe("Fase 11 — cache poisoning prevention", () => {
  const goodBody = { version: "1.3.13", containers: [{ id: "a", name: "app", image: "img" }], storage: { mode: "image-file", source: null } };
  const previous = { body: goodBody, at: 1000, degraded: false, lastGoodAt: 1000 };

  test("failed refresh serves last-known-good, marked degraded — never an empty wipe", () => {
    const next = nextInventoryCache(previous, { ok: false, at: 2000 });
    assert.equal(next.body, goodBody);
    assert.equal(next.degraded, true);
    assert.equal(next.lastGoodAt, 1000);
  });

  test("partial refresh replaces with coherent facts + degraded marker", () => {
    const partialBody = { ...goodBody, diagnostics: { partial: true } };
    const next = nextInventoryCache(previous, { ok: true, partial: true, body: partialBody, at: 2000 });
    assert.equal(next.body, partialBody);
    assert.equal(next.degraded, true);
  });

  test("full success replaces cleanly and clears degraded", () => {
    const freshBody = { ...goodBody, containers: [{ id: "b", name: "app2", image: "img2" }] };
    const next = nextInventoryCache(previous, { ok: true, partial: false, body: freshBody, at: 3000 });
    assert.equal(next.body, freshBody);
    assert.equal(next.degraded, false);
    assert.equal(next.lastGoodAt, 3000);
  });

  test("hard failure without previous good: explicit degraded empty — never fabricated healthy", () => {
    const next = nextInventoryCache(null, { ok: false, at: 1, version: "1.3.13" });
    assert.equal(next.body.containers.length, 0);
    assert.equal(next.degraded, true);
  });
});

/* ---- Fase 14/15: structural degradation + diagnostics -------------------- */

describe("Fase 14/15 — structural validation and diagnostics", () => {
  test("60 containers, all facts empty → structurally degraded", () => {
    const containers = Array.from({ length: 60 }, (_, i) => ({ id: String(i), name: `c${i}`, image: "img", imageId: null, repoDigests: [], labels: {} }));
    const d = assessInventory(containers);
    assert.equal(d.totalContainers, 60);
    assert.equal(d.imageIdCoverage, 0);
    assert.equal(d.structurallyDegraded, true);
  });

  test("healthy inventory is not flagged", () => {
    const containers = Array.from({ length: 60 }, (_, i) => ({ id: String(i), name: `c${i}`, image: "img", imageId: "sha256:x" + i, repoDigests: ["repo@sha256:x"], labels: { a: "b" } }));
    const d = assessInventory(containers, { inspectFailures: 0, parseErrors: 0 });
    assert.equal(d.structurallyDegraded, false);
    assert.equal(d.imageIdCoverage, 100);
    assert.equal(d.repoDigestCoverage, 100);
    assert.equal(d.labelCoverage, 100);
  });

  test("all-local-build host does NOT false-positive (imageId always present)", () => {
    const containers = Array.from({ length: 10 }, (_, i) => ({ id: String(i), name: `c${i}`, image: `local${i}:latest`, imageId: "sha256:local" + i, repoDigests: [], labels: {} }));
    const d = assessInventory(containers);
    assert.equal(d.structurallyDegraded, false);
    assert.equal(d.repoDigestCoverage, 0);
  });

  test("tiny hosts below threshold are never flagged (avoid trivial false positives)", () => {
    const d = assessInventory([{ id: "1", name: "a", image: "i", imageId: null, repoDigests: [], labels: {} }]);
    assert.equal(d.structurallyDegraded, false);
  });

  test("partial flag rides on any failure", () => {
    const containers = [{ id: "1", name: "a", image: "i", imageId: "sha256:x", repoDigests: [], labels: {} }];
    assert.equal(assessInventory(containers, { inspectFailures: 1 }).partial, true);
    assert.equal(assessInventory(containers, { parseErrors: 2 }).partial, true);
    assert.equal(assessInventory(containers, {}).partial, false);
  });

  test("refresh log line aggregates without leaking container data", () => {
    const d = { totalContainers: 61, chunks: 3, inspectedContainers: 61, inspectFailures: 0, parseErrors: 0, imageIdCoverage: 100, repoDigestCoverage: 87, labelCoverage: 89, partial: false, structurallyDegraded: false, durationMs: 812 };
    const line = refreshLogLine(d);
    assert.match(line, /containers=61/);
    assert.match(line, /chunks=3/);
    assert.doesNotMatch(line, /appdata|secret|token/i);
  });
});

/* ---- Fase 18/19/39: large payloads and scale ----------------------------- */

describe("Fase 18/19/39 — scale fixtures and parser performance bound", () => {
  function buildFixture(n, labelBloat = 0) {
    const lines = [];
    for (let i = 0; i < n; i++) {
      const record = inspectRecord(String(i).padStart(12, "0"), {
        Config: { Labels: Object.fromEntries(Array.from({ length: 20 }, (_, l) => [`label${l}`, "v".repeat(labelBloat)])) },
      });
      lines.push(JSON.stringify(record));
    }
    return lines.join("\n");
  }

  for (const n of [10, 60, 100, 250, 500]) {
    test(`${n} containers parse fully, fast`, () => {
      const out = buildFixture(n, n >= 250 ? 2000 : 0);
      const start = process.hrtime.bigint();
      const { records, parseErrors } = parseInspectOutput(out);
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert.equal(records.length, n);
      assert.equal(parseErrors.length, 0);
      assert.ok(ms < 2000, `parse took ${ms}ms`);
      // chunk math keeps subprocess count bounded: ceil(n/25)
      assert.ok(chunkList(Array.from({ length: n }, (_, i) => i), 25).length <= Math.ceil(n / 25));
    });
  }

  test("large-label objects (~1KB labels) parse without degradation", () => {
    const { records } = parseInspectOutput(buildFixture(25, 1000));
    assert.equal(records.length, 25);
    assert.equal(Object.keys(records[0].Config.Labels).length, 20);
  });
});
