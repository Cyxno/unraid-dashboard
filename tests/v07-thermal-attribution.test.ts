import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyEpisode,
  topContainersInRange,
  type TempSeriesPoint,
} from "../src/server/prometheus/thermal-diagnostics";

/** v0.7 episode attribution: documented rules + honest container data. */

describe("v07 episode classification (documented rules, no causality)", () => {
  it("load-correlated when avg CPU ≥ 50%", () => {
    assert.equal(classifyEpisode({ avgCpuPercent: 62, tempVsCpu: 0.1, tempVsPower: 0.1 }), "load-correlated");
  });

  it("load-correlated when temp↔cpu r ≥ 0.5", () => {
    assert.equal(classifyEpisode({ avgCpuPercent: 20, tempVsCpu: 0.7, tempVsPower: 0.2 }), "load-correlated");
  });

  it("power-correlated when temp↔power r ≥ 0.5 (and cpu rule misses)", () => {
    assert.equal(classifyEpisode({ avgCpuPercent: 20, tempVsCpu: 0.4, tempVsPower: 0.8 }), "power-correlated");
  });

  it("weakly-correlated for 0.3 ≤ |r| < 0.5", () => {
    assert.equal(classifyEpisode({ avgCpuPercent: 20, tempVsCpu: 0.35, tempVsPower: 0.1 }), "weakly-correlated");
  });

  it("low-CPU flat-correlation cases classify as idle-hot (v0.9.11 refined taxonomy)", () => {
    assert.equal(classifyEpisode({ avgCpuPercent: 15, tempVsCpu: 0.1, tempVsPower: 0.2 }), "idle-hot");
    // Unexplained survives when CPU is NOT low.
    assert.equal(classifyEpisode({ avgCpuPercent: 45, tempVsCpu: 0.1, tempVsPower: 0.2 }), "unexplained");
  });

  it("unexplained when correlations are missing entirely", () => {
    assert.equal(classifyEpisode({ avgCpuPercent: null, tempVsCpu: null, tempVsPower: null }), "unexplained");
  });
});

describe("v07 top containers in range (no fabricated attribution)", () => {
  const series = new Map<string, Array<{ t: number; v: number | null }>>([
    ["plex", [{ t: 100, v: 80 }, { t: 200, v: 60 }, { t: 300, v: null }]],
    ["backup", [{ t: 100, v: 30 }, { t: 200, v: 40 }]],
    ["idle-box", [{ t: 100, v: 1 }, { t: 200, v: 2 }]],
    ["sparse", [{ t: 250, v: 99 }]], // only one in-range sample → excluded
  ]);

  it("ranks by in-range average and caps at top N", () => {
    const top = topContainersInRange(series, 0, 400, 3);
    assert.deepEqual(
      top.map((entry) => entry.name),
      ["plex", "backup", "idle-box"],
    );
    assert.equal(top[0]?.avgCpuPercent, 70);
    assert.equal(top[0]?.peakCpuPercent, 80);
  });

  it("excludes containers with fewer than two in-range samples", () => {
    const top = topContainersInRange(series, 0, 400, 10);
    assert.ok(!top.some((entry) => entry.name === "sparse"));
  });

  it("excludes containers with no samples in the window at all", () => {
    const top = topContainersInRange(series, 10_000, 20_000, 10);
    assert.equal(top.length, 0);
  });

  it("returns empty for an empty series map", () => {
    assert.deepEqual(topContainersInRange(new Map(), 0, 100, 3), []);
  });

  it("handles null-heavy series", () => {
    const nullish = new Map<string, TempSeriesPoint[]>([
      ["x", [{ t: 1, v: null }, { t: 2, v: null }, { t: 3, v: null }]],
    ]);
    assert.deepEqual(topContainersInRange(nullish, 0, 10, 3), []);
  });
});
