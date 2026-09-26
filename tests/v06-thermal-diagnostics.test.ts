import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  alignSeries,
  bucketizeTemps,
  buildBuckets,
  buildHourlyTimeline,
  describeCorrelation,
  detectThermalEpisodes,
  pearsonCorrelation,
  type TempSeriesPoint,
} from "../src/server/prometheus/thermal-diagnostics";
import { TEMP_BUCKET_BOUNDS } from "../src/server/thresholds";
import { deriveHealth, type HealthInputs } from "../src/server/health";
import { classifySensor } from "../src/server/prometheus/thermal";

/** Builds a 60s-step series from per-minute values (epoch t0 = 0-based). */
function minuteSeries(values: number[], t0 = 1_700_000_000): TempSeriesPoint[] {
  return values.map((v, index) => ({ t: t0 + index * 60, v }));
}

describe("v06 thermal duration buckets", () => {
  it("bucketizes samples at the documented boundaries", () => {
    const counts = bucketizeTemps([65, 70, 79.9, 80, 89, 90, 94.9, 95, 99, null, NaN]);
    // <70: [65] → 1 ; 70–79: [70,79.9] → 2 ; 80–89: [80,89] → 2 ;
    // 90–94: [90,94.9] → 2 ; ≥95: [95,99] → 2
    assert.deepEqual(counts, [1, 2, 2, 2, 2]);
    assert.equal(TEMP_BUCKET_BOUNDS.length, 4);
  });

  it("reports coverage honestly for sparse data", () => {
    // 60 samples spanning 1 hour at 60s step → near-full coverage of 1h.
    const full = buildBuckets(minuteSeries(new Array(60).fill(60)), 3600);
    assert.ok(full.coverageRatio !== null && full.coverageRatio > 0.95);
    assert.equal(full.sampleCount, 60);
    // Only 6 samples over the same hour → ~10% coverage.
    const sparse = buildBuckets(minuteSeries([60, 60, 60, 60, 60, 60], 1_700_000_000), 3600);
    assert.ok(sparse.coverageRatio !== null && sparse.coverageRatio < 0.15);
  });

  it("handles empty data without NaN", () => {
    const empty = buildBuckets([], 86400);
    assert.deepEqual(empty.counts, [0, 0, 0, 0, 0]);
    assert.equal(empty.coverageRatio, null);
  });
});

describe("v06 thermal episode detection", () => {
  it("ignores single-sample spikes", () => {
    // 85°C for one minute, cool otherwise — no sustained episode.
    const values = new Array(60).fill(60);
    values[10] = 85;
    const episodes = detectThermalEpisodes(minuteSeries(values));
    assert.equal(episodes.length, 0);
  });

  it("requires the minimum sustained duration before confirming", () => {
    // 82°C for 4 minutes (< 5 min minimum) → discarded.
    const values = [...new Array(20).fill(60), ...new Array(4).fill(82), ...new Array(20).fill(60)];
    assert.equal(detectThermalEpisodes(minuteSeries(values)).length, 0);
    // 6 minutes → confirmed.
    const values2 = [...new Array(20).fill(60), ...new Array(6).fill(82), ...new Array(20).fill(60)];
    const episodes = detectThermalEpisodes(minuteSeries(values2));
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0]?.maxC, 82);
    // First→last sustained sample: 6 samples at 60s span 5 intervals.
    assert.equal(episodes[0]?.durationSeconds, 5 * 60);
  });

  it("applies hysteresis: brief dips below end threshold continue the same episode", () => {
    // 82°C 6min → 73°C for 3min (< 10min hold) → 84°C 6min → cool.
    const values = [
      ...new Array(10).fill(60),
      ...new Array(6).fill(82),
      ...new Array(3).fill(73),
      ...new Array(6).fill(84),
      ...new Array(30).fill(60),
    ];
    const episodes = detectThermalEpisodes(minuteSeries(values));
    assert.equal(episodes.length, 1);
    const episode = episodes[0]!;
    assert.equal(episode.maxC, 84);
    // Duration spans first excursion (t=10m) to last sample ≥ end (t=24m).
    assert.equal(episode.durationSeconds, 14 * 60);
  });

  it("closes an episode after the hold period below the end threshold", () => {
    const values = [
      ...new Array(5).fill(60),
      ...new Array(6).fill(83),
      ...new Array(12).fill(65), // 12 min below 75 → closes
      ...new Array(6).fill(83), // new episode
      ...new Array(20).fill(60),
    ];
    const episodes = detectThermalEpisodes(minuteSeries(values));
    assert.equal(episodes.length, 2);
    assert.ok(episodes[0]!.endMs !== null);
    assert.ok(episodes[1]!.endMs !== null);
  });

  it("marks an episode ongoing when the window ends hot", () => {
    const values = [...new Array(20).fill(60), ...new Array(8).fill(86)];
    const episodes = detectThermalEpisodes(minuteSeries(values));
    assert.equal(episodes.length, 1);
    assert.equal(episodes[0]?.endMs, null);
  });

  it("survives scrape gaps (nulls) without splitting an episode", () => {
    const values: Array<number | null> = [
      ...new Array(10).fill(60),
      ...new Array(4).fill(82),
      ...new Array(3).fill(null), // 3-minute scrape gap
      ...new Array(4).fill(83),
      ...new Array(20).fill(60),
    ];
    const episodes = detectThermalEpisodes(minuteSeries(values as number[]));
    assert.equal(episodes.length, 1);
  });

  it("computes episode averages from actual samples", () => {
    const values = [...new Array(5).fill(60), ...new Array(6).fill(80), ...new Array(5).fill(60)];
    const episodes = detectThermalEpisodes(minuteSeries(values));
    assert.equal(episodes[0]?.avgC, 80);
  });
});

describe("v06 correlation", () => {
  it("computes Pearson r on aligned pairs", () => {
    const pairs = [1, 2, 3, 4, 5].map((n) => ({ av: n, bv: n * 2 }));
    const r = pearsonCorrelation(pairs);
    assert.ok(r !== null && Math.abs(r - 1) < 1e-9);
  });

  it("returns null for insufficient or constant data", () => {
    assert.equal(pearsonCorrelation([]), null);
    assert.equal(pearsonCorrelation([{ av: 1, bv: 5 }]), null);
    assert.equal(pearsonCorrelation([{ av: 1, bv: 5 }, { av: 1, bv: 5 }, { av: 1, bv: 5 }]), null);
  });

  it("aligns series by nearest timestamp within tolerance", () => {
    const a = minuteSeries([80, 81, 82]);
    const b = minuteSeries([10, 20, 30], 1_700_000_000 + 15); // 15s offset
    const pairs = alignSeries(a, b, 90);
    assert.equal(pairs.length, 3);
    assert.equal(pairs[0]?.bv, 10);
  });

  it("skips pairs beyond tolerance", () => {
    const a = minuteSeries([80, 81, 82]);
    const b = minuteSeries([10, 20, 30], 1_700_000_000 + 600); // 10 min offset
    assert.equal(alignSeries(a, b, 90).length, 0);
  });

  it("labels correlation strength without causal language", () => {
    assert.equal(describeCorrelation(0.9), "strong positive");
    assert.equal(describeCorrelation(-0.6), "moderate negative");
    assert.equal(describeCorrelation(0.1), "negligible");
    assert.equal(describeCorrelation(null), "not computable");
  });
});

describe("v06 hourly timeline", () => {
  it("buckets by hour with max and avg", () => {
    const t0 = 1_700_000_000; // within one hour
    const points: TempSeriesPoint[] = [
      { t: t0, v: 70 },
      { t: t0 + 60, v: 80 },
      { t: t0 + 3600, v: 90 },
    ];
    const timeline = buildHourlyTimeline(points);
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0]?.maxC, 80);
    assert.equal(timeline[0]?.avgC, 75);
    assert.equal(timeline[1]?.maxC, 90);
  });
});

describe("v06 health thermal hysteresis", () => {
  const base = {
    storage: { status: "live", data: { state: "STARTED", totalBytes: 1, usedBytes: 0, freeBytes: 1, parityStatus: "COMPLETED", parityProgressPercent: null, disks: [] }, fetchedAt: "", ageMs: 0 },
    docker: { status: "live", data: { running: 0, total: 0, containers: [] }, fetchedAt: "", ageMs: 0 },
    notifications: { status: "live", data: { unreadCounts: { info: 0, warning: 0, alert: 0 }, recent: [] }, fetchedAt: "", ageMs: 0 },
    memoryPercent: 40,
    temperatureCriticalCount: 0,
    sustainedCpuPercent: null,
    loadLevel: null,
    prometheusStatus: null,
  } satisfies Pick<HealthInputs, "memoryPercent" | "temperatureCriticalCount" | "sustainedCpuPercent" | "loadLevel" | "prometheusStatus"> & Record<string, unknown>;

  it("does NOT mark critical from a single transient critical sample", () => {
    const health = deriveHealth({
      ...base,
      storage: base.storage as HealthInputs["storage"],
      docker: base.docker as HealthInputs["docker"],
      notifications: base.notifications as HealthInputs["notifications"],
      cpuPackageC: 95,
      cpuPackage5mAvgC: 78,
    } as HealthInputs);
    assert.equal(health.level, "attention");
    assert.ok(health.reasons.join(" ").includes("sustained average"));
  });

  it("marks critical when the 5m average is critical", () => {
    const health = deriveHealth({
      ...base,
      storage: base.storage as HealthInputs["storage"],
      docker: base.docker as HealthInputs["docker"],
      notifications: base.notifications as HealthInputs["notifications"],
      cpuPackageC: 91,
      cpuPackage5mAvgC: 90.5,
    } as HealthInputs);
    assert.equal(health.level, "critical");
  });

  it("stays healthy below thresholds", () => {
    const health = deriveHealth({
      ...base,
      storage: base.storage as HealthInputs["storage"],
      docker: base.docker as HealthInputs["docker"],
      notifications: base.notifications as HealthInputs["notifications"],
      cpuPackageC: 75,
      cpuPackage5mAvgC: 72,
    } as HealthInputs);
    assert.equal(health.level, "healthy");
  });

  it("flags sustained warning-level average as attention", () => {
    const health = deriveHealth({
      ...base,
      storage: base.storage as HealthInputs["storage"],
      docker: base.docker as HealthInputs["docker"],
      notifications: base.notifications as HealthInputs["notifications"],
      cpuPackageC: 81,
      cpuPackage5mAvgC: 81,
    } as HealthInputs);
    assert.equal(health.level, "attention");
  });
});

describe("v06 sensor classification sanity", () => {
  it("classifies coretemp package and cores", () => {
    assert.equal(classifySensor("coretemp", "Package id 0"), "package");
    assert.equal(classifySensor("coretemp", "Core 0"), "core");
    assert.equal(classifySensor("acpitz", "temp1"), "board");
  });
});
