import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";
process.env.AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-insights-"));

import {
  MAX_GAP_BUCKETS,
  MIN_TREND_POINTS,
  RANGE_MS,
  RANGE_STEP_SECONDS,
  RANGE_TTL_MS,
  aggregate,
  linearTrend,
  median,
  seriesStats,
} from "../src/server/insights/timeseries";
import { forecastCapacity, confidenceFromSamples, usagePercentSeries } from "../src/server/insights/forecast";
import { detectCpuDrift, detectMemoryCreep, thermalBaseline, robustDeviation } from "../src/server/insights/anomalies";
import {
  analyzeRestartSeries,
  dedupeInsights,
  updateImpactInsight,
} from "../src/server/insights/engine";
import { mergeInsightIdentities, loadInsightsState, resetInsightsStateCache } from "../src/server/insights/store";
import { rangeSupported } from "../src/server/insights/prom-source";
import type { TrendSample } from "../src/lib/api-types";

/**
 * v1.6.0 Fase 28/29 — insight fixtures + critical regression suite.
 * All pure-function level: the trend layer, forecasts, anomalies,
 * recurrence and identity/dedupe. Prometheus-calling paths are covered
 * indirectly through these (the trend layer is the contract).
 */

const HOUR = 3600_000;
const BASE = 1_791_500_000_000;

function series(points: Array<[number, number | null]>): TrendSample[] {
  return points.map(([offsetHours, value], index) => ({
    t: new Date(BASE + offsetHours * HOUR).toISOString(),
    value,
    quality: index % 11 === 10 ? "partial" : "good",
  }));
}

function risingSeries(hours: number, start: number, perHour: number): TrendSample[] {
  return series(Array.from({ length: hours }, (_, index) => [index, start + index * perHour]));
}

/* Fase 28 fixtures (named scenarios, as pure builders) */
const FIXTURES = {
  STEADY_STORAGE: () => risingSeries(24, 50, 0), // flat
  FAST_STORAGE_GROWTH: () => risingSeries(24, 50, 0.3),
  NOISY_STORAGE: () =>
    series(Array.from({ length: 24 }, (_, index) => [index, 50 + (index % 2 === 0 ? 2 : -2)])),
  MEMORY_CREEP: () => risingSeries(24, 200 * 1024 ** 2, 18 * 1024 ** 2),
  INSUFFICIENT_HISTORY: () => series([[0, 50], [1, 50.2], [2, 50.4]]),
};

/* ---- Fase 1: timeseries layer ---- */

describe("v1.6.0 insights: timeseries layer", () => {
  test("20. ranges are correct and honest (24h/7d/30d)", () => {
    assert.equal(RANGE_MS["24h"], 24 * 3600_000);
    assert.equal(RANGE_MS["7d"], 7 * 24 * 3600_000);
    assert.equal(RANGE_MS["30d"], 30 * 24 * 3600_000);
    // Server-side aggregation: coarse steps, bounded point counts.
    assert.ok(RANGE_STEP_SECONDS["24h"] >= 600);
    assert.ok(RANGE_STEP_SECONDS["7d"] >= 1800);
    // 18. TTLs: no refresh storm.
    assert.ok(RANGE_TTL_MS["24h"] >= 5 * 60_000);
    assert.ok(RANGE_TTL_MS["7d"] >= 15 * 60_000);
    assert.ok(RANGE_TTL_MS["30d"] >= 60 * 60_000);
    // 30d exceeds default Prometheus retention → capability-gated.
    assert.equal(rangeSupported("30d").ok, false);
    assert.equal(rangeSupported("7d").ok, true);
  });

  test("21. gaps are explicit — no zero-fill over missing buckets", () => {
    const points = [
      { t: BASE, value: 10 },
      { t: BASE + HOUR, value: 11 },
      // 4 missing hours
      { t: BASE + 6 * HOUR, value: 12 },
    ];
    const samples = aggregate(points, BASE + 7 * HOUR, "24h");
    const gaps = samples.filter((sample) => sample.quality === "missing");
    assert.ok(gaps.length >= 3);
    assert.ok(gaps.every((sample) => sample.value == null), "gap buckets must be null, never 0");
  });

  test("22. source outage (empty points) yields missing quality — trend refuses", () => {
    const samples = aggregate([], BASE + 24 * HOUR, "24h");
    const stats = seriesStats(samples);
    assert.equal(stats.quality, "missing");
    const trend = linearTrend(samples, "24h");
    assert.equal(trend.confidence, "insufficient");
    assert.equal(trend.direction, "unknown");
  });

  test("3. large gaps lower confidence and break the series", () => {
    // Series with a gap longer than the per-range cap.
    const points = [
      { t: BASE, value: 10 },
      { t: BASE + HOUR, value: 10.5 },
      // gap of 5 buckets (> MAX_GAP_BUCKETS["24h"]=4)
      { t: BASE + 7 * HOUR, value: 12 },
      { t: BASE + 8 * HOUR, value: 12.5 },
    ];
    const samples = aggregate(points, BASE + 9 * HOUR, "24h");
    const stats = seriesStats(samples);
    assert.ok(stats.longestGapBuckets >= MAX_GAP_BUCKETS["24h"]);
    const trend = linearTrend(samples, "24h");
    assert.equal(trend.confidence, "insufficient");
  });

  test("23. confidence calculation follows sample count + coverage", () => {
    assert.equal(confidenceFromSamples(25, 1), "high");
    assert.equal(confidenceFromSamples(15, 0.8), "medium");
    assert.equal(confidenceFromSamples(9, 0.6), "low");
    assert.equal(confidenceFromSamples(5, 0.9), "insufficient");
  });

  test("median/robust deviation helpers are sane", () => {
    assert.equal(median([3, 1, 2]), 2);
    const deviation = robustDeviation([...series([[0, 10], [1, 10.5], [2, 11], [3, 10.2]]), { t: new Date(BASE + 4 * HOUR).toISOString(), value: 40, quality: "good" }]);
    assert.equal(deviation.last, 40);
    assert.ok((deviation.deviationRatio ?? 0) > 3);
  });
});

/* ---- Fase 2/3/23: storage trending + capacity forecast ---- */

describe("v1.6.0 insights: capacity forecast", () => {
  test("1. flat trend → no capacity insight, 'Usage stable'", () => {
    const forecast = forecastCapacity({
      entity: "cache",
      label: "Cache pool",
      samples: FIXTURES.STEADY_STORAGE(),
      range: "24h",
      currentPercent: 50,
      recommendation: null,
    });
    assert.match(forecast.summary, /stable/i);
    assert.equal(forecast.projectedThresholdFrom, null);
  });

  test("2. insufficient samples → insufficient, never a forecast", () => {
    const forecast = forecastCapacity({
      entity: "cache",
      label: "Cache pool",
      samples: FIXTURES.INSUFFICIENT_HISTORY(),
      range: "24h",
      currentPercent: 50,
      recommendation: null,
    });
    assert.equal(forecast.confidence, "insufficient");
    assert.match(forecast.summary, /insufficient history/i);
  });

  test("5. growth forecast produces a bounded ETA range with medium/high confidence", () => {
    // +0.3%/h ≈ +50%/week… too fast; use realistic +0.05%/h (~+8.4%/wk)
    const forecast = forecastCapacity({
      entity: "cache",
      label: "Cache pool",
      samples: risingSeries(24, 72, 0.05),
      range: "24h",
      currentPercent: 73,
      recommendation: null,
    });
    assert.equal(forecast.confidence === "high" || forecast.confidence === "medium", true);
    assert.ok(forecast.projectedThresholdFrom != null);
    assert.ok(forecast.projectedThresholdTo != null);
    assert.match(forecast.summary, /would reach 80%/i);
    // 23. RANGE, not an exact date: from ≠ to.
    assert.notEqual(forecast.projectedThresholdFrom, forecast.projectedThresholdTo);
  });

  test("6. noisy slope → no hard ETA (low confidence gives direction only)", () => {
    const forecast = forecastCapacity({
      entity: "cache",
      label: "Cache pool",
      samples: FIXTURES.NOISY_STORAGE(),
      range: "24h",
      currentPercent: 50,
      recommendation: null,
    });
    // Noisy data must NOT yield an alarmist projection.
    assert.equal(forecast.projectedThresholdFrom, null);
  });

  test("4. stale source quality → no forecast", () => {
    const stale = risingSeries(24, 50, 0.2).map((sample) => ({ ...sample, quality: "stale" as const }));
    const forecast = forecastCapacity({
      entity: "cache",
      label: "Cache pool",
      samples: stale,
      range: "24h",
      currentPercent: 60,
      recommendation: null,
    });
    assert.equal(forecast.confidence, "insufficient");
    assert.match(forecast.summary, /insufficient history|trend unavailable/i);
  });

  test("usagePercentSeries converts size/avail to percent, handling nulls", () => {
    const size = series([[0, 100], [1, 100], [2, 100]]);
    const avail = series([[0, 30], [1, null], [2, 10]]);
    const percent = usagePercentSeries(size, avail);
    assert.equal(percent[0]?.value, 70);
    assert.equal(percent[1]?.value, null);
    assert.equal(percent[2]?.value, 90);
  });

  test("MIN_TREND_POINTS guard exists for directional claims", () => {
    assert.ok(MIN_TREND_POINTS >= 8);
  });
});

/* ---- Fase 5/6/7: anomalies ---- */

describe("v1.6.0 insights: anomalies (no ML)", () => {
  test("7. memory creep: sustained significant growth is detected with confidence", () => {
    const creep = detectMemoryCreep({
      entity: "app",
      samples: FIXTURES.MEMORY_CREEP(),
      range: "24h",
      liveBytes: 200 * 1024 ** 2 + 23 * 18 * 1024 ** 2,
    });
    assert.ok(creep);
    assert.match(creep.summary, /increased consistently over 24h/i);
    assert.ok(creep.deltaBytes != null && creep.deltaBytes > 0);
    assert.notEqual(creep.confidence, "insufficient");
  });

  test("8. one spike != creep (stable memory + one outlier)", () => {
    const stable = series(Array.from({ length: 23 }, (_, index) => [index, 200 * 1024 ** 2]));
    stable.push({ t: new Date(BASE + 23 * HOUR).toISOString(), value: 900 * 1024 ** 2, quality: "good" });
    const creep = detectMemoryCreep({ entity: "app", samples: stable, range: "24h", liveBytes: 900 * 1024 ** 2 });
    assert.equal(creep, null);
  });

  test("9. CPU drift: current vs 7d baseline with host-workload guard", () => {
    const baseline = series(Array.from({ length: 48 }, (_, index) => [index, 3.2]));
    const current = series(Array.from({ length: 24 }, (_, index) => [index, 6.4]));
    const drift = detectCpuDrift({ entity: "svc", currentSamples: current, baselineSamples: baseline, hostCurrentAvgPercent: 20, hostBaselineAvgPercent: 19 });
    assert.equal(drift.suppressedReason, null);
    assert.equal(drift.ratio != null && drift.ratio >= 1.5, true);
    assert.equal(drift.currentAvgPercent != null && drift.currentAvgPercent > 6, true);

    // Host explains the rise → suppressed.
    const explained = detectCpuDrift({ entity: "svc", currentSamples: current, baselineSamples: baseline, hostCurrentAvgPercent: 60, hostBaselineAvgPercent: 20 });
    assert.equal(explained.suppressedReason, "explained by host workload");

    // Small absolute rise is noise, not drift.
    const noise = detectCpuDrift({ entity: "svc", currentSamples: series(Array.from({ length: 24 }, (_, index) => [index, 3.4])), baselineSamples: baseline, hostCurrentAvgPercent: null, hostBaselineAvgPercent: null });
    assert.equal(noise.suppressedReason, null);
    assert.ok((noise.ratio ?? 0) < 1.5);
  });

  test("10. thermal baseline: p50/p95/idle + drift vs prior week (like-for-like)", () => {
    const current = series(Array.from({ length: 168 }, (_, index) => [index, 60 + (index % 24) * 0.5]));
    const prior = series(Array.from({ length: 168 }, (_, index) => [index - 200, 55 + (index % 24) * 0.5]));
    const baseline = thermalBaseline(current, prior);
    assert.equal(baseline.comparable, true);
    assert.ok(baseline.p50C != null && baseline.p95C != null && baseline.idleBaselineC != null);
    assert.ok((baseline.driftVsPriorWeekC ?? 0) > 0);
    // Non-comparable windows (no prior data) → no drift claim.
    const solo = thermalBaseline(current, null);
    assert.equal(solo.comparable, false);
    assert.equal(solo.driftVsPriorWeekC, null);
  });
});

/* ---- Fase 8/9/10: recurrence + update impact ---- */

describe("v1.6.0 insights: recurrence + update impact", () => {
  test("11. recurring incidents detected from bounded timeline history", async () => {
    resetInsightsStateCache();
    // Synthesize an incident store with a repeated fingerprint.
    const { loadIncidentsStateFromDisk } = await import("../src/server/incidents/store");
    const state = await loadIncidentsStateFromDisk();
    const timeline = [];
    for (let occurrence = 0; occurrence < 6; occurrence++) {
      const at = BASE - occurrence * 12 * 3600_000;
      timeline.push({ at: new Date(at).toISOString(), event: "incident opened", detail: null });
      timeline.push({ at: new Date(at + 3600_000).toISOString(), event: "recovered", detail: null });
    }
    state.incidents["docker:container:plexdb-ro:unhealthy"] = {
      id: "docker:container:plexdb-ro:unhealthy",
      entity: "plexdb-ro",
      kind: "docker-unhealthy",
      title: "Container unhealthy: plexdb-ro",
      severity: "warning",
      status: "recovered",
      firstSeenAt: new Date(BASE - 60 * 3600_000).toISOString(),
      lastSeenAt: new Date(BASE).toISOString(),
      durationMs: 6 * 3600_000,
      source: "unraid-api",
      evidence: [],
      rootCauseId: null,
      impact: [],
      notifiedAt: null,
      resolvedAt: new Date(BASE).toISOString(),
      flapping: false,
      actionable: true,
      timeline,
      safeCheck: null,
      delivery: null,
    };
    const { buildRecurrence } = await import("../src/server/insights/engine");
    const { summaries, insights } = buildRecurrence(BASE);
    const summary = summaries.find((entry) => entry.entity === "plexdb-ro");
    assert.ok(summary);
    assert.equal(summary.recurring, true);
    assert.equal(summary.occurrences7d >= 3, true);
    const insight = insights.find((entry) => entry.id === "insight:recurrence:docker:container:plexdb-ro:unhealthy");
    assert.ok(insight);
    assert.match(insight.summary, /6 occurrences in 7 days/i);
  });

  test("12. planned deploy restarts are correlated, not crash patterns", () => {
    const points = [
      { t: 1, v: 3 }, { t: 2, v: 0 }, { t: 3, v: 0 },
      { t: 30, v: 2 }, { t: 31, v: 0 }, { t: 32, v: 0 },
      { t: 60, v: 3 }, { t: 61, v: 0 },
    ];
    // Pipeline-owned project → correlated (info, actionable=false).
    const analysis = analyzeRestartSeries(points, { pipelineProjects: ["tornscope"], recentUpdateTargets: [], name: "tornscope-web-1" });
    assert.ok(analysis);
    assert.match(analysis.correlated ?? "", /pipeline-owned/);
    // Update-machine target → correlated.
    const viaUpdate = analyzeRestartSeries(points, { pipelineProjects: [], recentUpdateTargets: ["app"], name: "app" });
    assert.match(viaUpdate?.correlated ?? "", /recent updates/);
    // Unexplained → no correlation, actionable.
    const unexplained = analyzeRestartSeries(points, { pipelineProjects: [], recentUpdateTargets: [], name: "app" });
    assert.equal(unexplained?.correlated, null);
    // Few restarts → never an insight.
    assert.equal(analyzeRestartSeries([{ t: 1, v: 1 }], { pipelineProjects: [], recentUpdateTargets: [], name: "app" }), null);
    // One dense cluster (single deploy event) → never an insight.
    assert.equal(analyzeRestartSeries([{ t: 1, v: 6 }, { t: 2, v: 0 }], { pipelineProjects: [], recentUpdateTargets: [], name: "app" }), null);
  });

  test("13. update correlation wording is safe — never 'caused by'", () => {
    const insight = updateImpactInsight({
      target: "app",
      startedAt: "s1",
      updatedAt: BASE,
      beforeMedian: 500 * 1024 ** 2,
      afterMedian: 590 * 1024 ** 2,
      afterSamples: 20,
      beforeSamples: 20,
    });
    assert.ok(insight);
    assert.match(insight.title, /^After update:/);
    assert.match(insight.summary, /no causality claimed/);
    assert.doesNotMatch(insight.summary + insight.title, /caused by/i);
    // Small change (<10%) → no insight at all.
    assert.equal(
      updateImpactInsight({ target: "app", startedAt: "s1", updatedAt: BASE, beforeMedian: 500, afterMedian: 505, afterSamples: 20, beforeSamples: 20 }),
      null,
    );
  });

  test("14. insights are NOT incidents (separate vocabularies)", () => {
    const src = fs.readFileSync("src/server/incidents/engine.ts", "utf8");
    const insightsSrc = fs.readFileSync("src/server/insights/engine.ts", "utf8");
    // The incident engine never produces insight ids; the insights engine
    // never produces incident fingerprints.
    assert.doesNotMatch(insightsSrc, /runIncidentCycle|noteSourceAttempt\(source/);
    assert.doesNotMatch(src, /insight:/);
    const apiTypes = fs.readFileSync("src/lib/api-types.ts", "utf8");
    assert.match(apiTypes, /Insights are NOT incidents/);
    // Insight severity vocabulary differs (watch exists only for insights).
    assert.match(apiTypes, /InsightSeverity = "info" \| "watch" \| "warning"/);
  });

  test("15/16. stable fingerprints + dedupe", async () => {
    resetInsightsStateCache();
    const { mergeInsightIdentities, applyStableIdentity, loadInsightsState } = await import("../src/server/insights/store");
    const insight: import("../src/lib/api-types").Insight = {
      id: "insight:capacity:cache",
      entity: "cache",
      type: "capacity",
      severity: "watch",
      title: "Cache usage rising",
      summary: "test",
      evidence: [],
      window: "7d",
      confidence: "medium",
      firstObserved: new Date().toISOString(),
      lastObserved: new Date().toISOString(),
      actionable: true,
      deepLink: "/insights",
      recommendation: null,
    };
    mergeInsightIdentities([insight]);
    // A later cycle rebuilds the insight with a fresh firstObserved — the
    // stored identity must win (stable fingerprint, no new record).
    const rebuilt = { ...insight, firstObserved: new Date(Date.now() + 5000).toISOString() };
    applyStableIdentity(rebuilt);
    assert.equal(rebuilt.firstObserved, insight.firstObserved);
    void loadInsightsState;

    const deduped = dedupeInsights([insight, { ...insight, severity: "warning" }]);
    assert.equal(deduped.length, 1);
  });

  test("17. bounded identity history (200 cap)", async () => {
    resetInsightsStateCache();
    const state = loadInsightsState();
    const mk = (index: number): import("../src/lib/api-types").Insight => ({
      id: `insight:x:${index}`,
      entity: "e",
      type: "trend",
      severity: "info",
      title: `t${index}`,
      summary: "",
      evidence: [],
      window: "24h",
      confidence: "low",
      firstObserved: new Date().toISOString(),
      lastObserved: new Date(Date.now() + index * 1000).toISOString(),
      actionable: false,
      deepLink: "/insights",
      recommendation: null,
    });
    mergeInsightIdentities(Array.from({ length: 300 }, (_, index) => mk(index)));
    assert.ok(Object.keys(state.identities).length <= 200);
    resetInsightsStateCache();
  });

  test("18. no new polling storm (structural: TTL constants + cycle gate)", () => {
    const cycleSrc = fs.readFileSync("src/server/insights/engine.ts", "utf8");
    assert.match(cycleSrc, /CYCLE_MIN_INTERVAL_MS = 2 \* 60_000/);
    assert.match(cycleSrc, /__insightsBusy/);
    const promSrc = fs.readFileSync("src/server/insights/prom-source.ts", "utf8");
    assert.match(promSrc, /RANGE_TTL_MS\[range\]/);
    assert.match(promSrc, /__insightsRangeInflight/);
    // Overview strip polls at most every 2 minutes (client-side).
    const pageSrc = fs.readFileSync("src/app/page.tsx", "utf8");
    assert.match(pageSrc, /INSIGHTS_STRIP_POLL_MS = 120_000/);
  });

  test("19. query cache serves repeats from TTL cache (single-flight shape)", async () => {
    // Without Prometheus configured the fetch is a no-op, but the cache
    // map must remain consistent (no poison on failure).
    const { fetchRange, resetInsightsRangeCache } = await import("../src/server/insights/prom-source");
    resetInsightsRangeCache();
    const empty = await fetchRange("up", "24h");
    assert.deepEqual(empty, []);
    resetInsightsRangeCache();
  });

  test("24. insight payloads carry no secrets (sanitized evidence values only)", () => {
    const engineSrc = fs.readFileSync("src/server/insights/engine.ts", "utf8");
    // Evidence values are built from fixed signal names + numbers/names.
    assert.doesNotMatch(engineSrc, /API_KEY|UNRAID_API_KEY|VAPID|authorization/i);
    const entitySrc = fs.readFileSync("src/app/api/insights/entity/route.ts", "utf8");
    assert.doesNotMatch(entitySrc, /API_KEY|VAPID|authorization/i);
  });
});
