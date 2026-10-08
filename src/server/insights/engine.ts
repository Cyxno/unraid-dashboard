import type {
  CapacityForecast,
  InsightsPayload,
  Insight,
  InsightEvidence,
  InsightSeverity,
  MemoryCreepInsight,
  RecurrenceSummary,
  SourcePerformanceEntry,
  TrendRange,
  TrendSample,
} from "@/lib/api-types";
import { allSourceLatencyStats, getAllSourceHealth } from "@/server/incidents/source-health";
import { loadIncidentsState } from "@/server/incidents/store";
import { readUpdateHistory } from "@/server/update/history";
import { getPromClient, isPrometheusConfigured } from "@/server/prometheus/client";
import { fetchAggregated, prometheusHistoryCapability, rangeSupported, resetInsightsRangeCache } from "./prom-source";
import { detectCpuDrift, detectMemoryCreep, thermalBaseline } from "./anomalies";
import { forecastCapacity, usagePercentSeries } from "./forecast";
import { applyStableIdentity, ensureInsightsState, getInsightPushPreferences, mergeInsightIdentities, scheduleInsightsStateSave } from "./store";
import { median } from "./timeseries";
import { escapePromQL } from "./engine-helpers";

/**
 * Operational insights engine (v1.6.0 Fase 13).
 *
 * One canonical cycle turning EXISTING local history (Prometheus range
 * queries, incident store, update history, latency rings) into bounded,
 * fingerprinted INSIGHTS — never incidents, never pushed by default
 * (Fase 25), never an aggregate health score (Fase 12).
 *
 * Cost is bounded (Fase 22): every Prometheus range query is TTL-cached
 * per (query, range) and the cycle itself is single-flight with a
 * minimum interval; UI polls serve the cached snapshot.
 */

const globalStore = globalThis as unknown as {
  __insightsSnapshot?: InsightsPayload;
  __insightsCycleAt?: number;
  __insightsBusy?: boolean;
};

/** Minimum interval between full cycles (Fase 22: no refresh every 5s). */
const CYCLE_MIN_INTERVAL_MS = 2 * 60_000;

function evidence(signal: string, value: string, window: TrendRange, quality: InsightEvidence["quality"], source = "prometheus"): InsightEvidence {
  return { signal, value, source, window, quality };
}

function nowIso(): string {
  return new Date().toISOString();
}


function formatBytes(bytes: number | null): string {
  if (bytes == null) return "?";
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (abs >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

/** Instant top-N names via a short window range query (labels preserved). */
async function topNames(query: string, limit: number): Promise<string[]> {
  if (!isPrometheusConfigured()) return [];
  try {
    const prom = getPromClient();
    const seriesList = await prom.range(
      query,
      Math.floor((Date.now() - 30 * 60_000) / 1000),
      Math.floor(Date.now() / 1000),
      300,
    );
    return seriesList.map((series) => String(series.metric.name ?? "")).filter(Boolean).slice(0, limit);
  } catch {
    return [];
  }
}

/* ---- Storage capacity (Fase 2/3) ------------------------------------------ */

interface FilesystemTarget {
  entity: string;
  label: string;
  mountpoint: string;
  recommendation: string;
}

function filesystemTargets(): FilesystemTarget[] {
  const targets: FilesystemTarget[] = [
    { entity: "cache", label: "Cache pool", mountpoint: "/mnt/cache", recommendation: "Review largest cache consumers." },
    { entity: "array", label: "Array (user shares)", mountpoint: "/mnt/user", recommendation: "Review largest share consumers or expand the array." },
    { entity: "vm_storage", label: "VM storage", mountpoint: "/mnt/vm_storage", recommendation: "Review VM image sizes." },
  ];
  for (let disk = 1; disk <= 28; disk++) {
    targets.push({
      entity: `disk${disk}`,
      label: `Disk ${disk}`,
      mountpoint: `/mnt/disk${disk}`,
      recommendation: "Consider rebalancing shares across disks.",
    });
  }
  return targets;
}

function fsQuery(metric: string, mountpoint: string): string {
  return `${metric}{mountpoint="${mountpoint}",fstype!=""}`;
}

function emptyForecast(target: { entity: string; label: string }, reason: string): CapacityForecast {
  return {
    entity: target.entity,
    label: target.label,
    metric: "storage-usage-percent",
    current: null,
    growthPerDay: null,
    growthPerWeek: null,
    window: "24h",
    projectedThreshold: 90,
    projectedThresholdFrom: null,
    projectedThresholdTo: null,
    summary: reason,
    confidence: "insufficient",
    sampleCount: 0,
    dataQuality: "missing",
    recommendation: null,
  };
}

async function buildCapacity(): Promise<{ forecasts: CapacityForecast[]; insights: Insight[] }> {
  const forecasts: CapacityForecast[] = [];
  const insights: Insight[] = [];
  for (const target of filesystemTargets()) {
    const [size24h, avail24h, size7d, avail7d] = await Promise.all([
      fetchAggregated(fsQuery("node_filesystem_size_bytes", target.mountpoint), "24h"),
      fetchAggregated(fsQuery("node_filesystem_avail_bytes", target.mountpoint), "24h"),
      fetchAggregated(fsQuery("node_filesystem_size_bytes", target.mountpoint), "7d"),
      fetchAggregated(fsQuery("node_filesystem_avail_bytes", target.mountpoint), "7d"),
    ]);

    // Source-outage suppression: an empty series means the source could
    // not answer — never a fabricated forecast (Fase 29-22).
    if (size24h.points.length === 0 || avail24h.points.length === 0) {
      const sourceHealth = getAllSourceHealth().find((entry) => entry.source === "prometheus");
      const suppress = sourceHealth && sourceHealth.status !== "healthy";
      forecasts.push(emptyForecast(target, suppress ? "trend unavailable (source degraded)" : "no data for this mountpoint"));
      continue;
    }

    const percent24h = usagePercentSeries(size24h.samples, avail24h.samples);
    const percent7d = usagePercentSeries(size7d.samples, avail7d.samples);
    const latestSize = size24h.points.at(-1)?.value ?? null;
    const latestAvail = avail24h.points.at(-1)?.value ?? null;
    const currentPercent = latestSize != null && latestAvail != null && latestSize > 0 ? ((latestSize - latestAvail) / latestSize) * 100 : null;

    const prefer7d = rangeSupported("7d").ok && percent7d.filter((sample) => sample.value != null).length >= 12;
    const forecast = forecastCapacity({
      entity: target.entity,
      label: target.label,
      samples: prefer7d ? percent7d : percent24h,
      range: prefer7d ? "7d" : "24h",
      currentPercent,
      recommendation: target.recommendation,
    });
    forecasts.push(forecast);

    // WATCH SOON insight: rising with enough confidence AND the 90%
    // projection landing within the believable horizon.
    if (
      (forecast.confidence === "high" || forecast.confidence === "medium") &&
      forecast.growthPerWeek != null &&
      forecast.growthPerWeek > 0 &&
      forecast.projectedThresholdFrom != null
    ) {
      const daysOut = (Date.parse(forecast.projectedThresholdFrom) - Date.now()) / 86_400_000;
      if (daysOut <= 60) {
        insights.push({
          id: `insight:capacity:${target.entity}`,
          entity: target.entity,
          type: "capacity",
          severity: daysOut <= 14 ? "warning" : "watch",
          title: `${target.label} usage rising`,
          summary: `${forecast.summary} (currently ${Math.round(forecast.current ?? 0)}%, +${forecast.growthPerWeek.toFixed(1)}%/week)`,
          evidence: [
            evidence(
              "storage.usagePercent",
              `current=${Math.round(forecast.current ?? 0)}% growth=${forecast.growthPerWeek?.toFixed(2)}%/week`,
              forecast.window,
              forecast.dataQuality,
            ),
          ],
          window: forecast.window,
          confidence: forecast.confidence,
          firstObserved: nowIso(),
          lastObserved: nowIso(),
          actionable: true,
          deepLink: "/insights",
          recommendation: target.recommendation,
        });
      }
    }
  }
  return { forecasts, insights };
}

/* ---- Memory creep (Fase 5) --------------------------------------------------- */

async function buildMemoryCreep(): Promise<{ creep: MemoryCreepInsight[]; insights: Insight[] }> {
  const creep: MemoryCreepInsight[] = [];
  const insights: Insight[] = [];
  const names = await topNames('topk(6, avg_over_time(container_memory_working_set_bytes{name!=""}[24h]))', 6);
  // Label-drift can surface the same container twice — one creep record
  // per entity (Fase 15).
  const uniqueNames = [...new Set(names)];
  for (const name of uniqueNames) {
    const selector = `container_memory_working_set_bytes{name="${escapePromQL(name)}"}`;
    const series = await fetchAggregated(selector, "24h");
    const live = series.points.at(-1)?.value ?? null;
    const found = detectMemoryCreep({ entity: name, samples: series.samples, range: "24h", liveBytes: live });
    if (found) {
      creep.push(found);
      insights.push({
        id: `insight:memory-creep:${name}`,
        entity: name,
        type: "trend",
        severity: "watch",
        title: `Memory creep: ${name}`,
        summary: found.summary,
        evidence: [
          evidence(
            "container.memory",
            `start=${formatBytes(found.startBytes)} current=${formatBytes(found.currentBytes)} slope=${formatBytes(found.slopeBytesPerHour ?? 0)}/h`,
            "24h",
            "partial",
          ),
        ],
        window: "24h",
        confidence: found.confidence,
        firstObserved: nowIso(),
        lastObserved: nowIso(),
        actionable: true,
        deepLink: `/docker/${encodeURIComponent(name)}`,
        recommendation: "Check whether memory increase persists after restart.",
      });
    }
  }
  return { creep, insights };
}

/* ---- CPU drift (Fase 6) --------------------------------------------------------- */

async function buildCpuDrift(): Promise<Insight[]> {
  const insights: Insight[] = [];
  const hostCurrent = await fetchAggregated('100 - (avg by() (rate(node_cpu_seconds_total{mode="idle"}[10m])) * 100)', "24h");
  const hostCurrentAvg = median(hostCurrent.samples.filter((sample) => sample.value != null).map((sample) => sample.value as number));
  const hostBaseline = await fetchAggregated('100 - (avg by() (rate(node_cpu_seconds_total{mode="idle"}[10m])) * 100)', "7d");
  const hostBaselineAvg = median(hostBaseline.samples.filter((sample) => sample.value != null).map((sample) => sample.value as number));

  const names = await topNames('topk(5, avg_over_time(rate(container_cpu_usage_seconds_total{name!=""}[10m])[24h:10m]) * 100)', 5);
  for (const name of names) {
    const selector = `rate(container_cpu_usage_seconds_total{name="${escapePromQL(name)}"}[10m]) * 100`;
    const [current, baseline] = await Promise.all([
      fetchAggregated(selector, "24h"),
      fetchAggregated(selector, "7d"),
    ]);
    const result = detectCpuDrift({
      entity: name,
      currentSamples: current.samples,
      baselineSamples: baseline.samples,
      hostCurrentAvgPercent: hostCurrentAvg,
      hostBaselineAvgPercent: hostBaselineAvg,
    });
    if (
      result.suppressedReason == null &&
      result.ratio != null &&
      result.confidence !== "insufficient" &&
      result.currentAvgPercent != null &&
      result.baselineAvgPercent != null
    ) {
      const increase = Math.round((result.ratio - 1) * 100);
      insights.push({
        id: `insight:cpu-drift:${name}`,
        entity: name,
        type: "degradation",
        severity: result.ratio >= 3 ? "warning" : "watch",
        title: `CPU drift: ${name}`,
        summary: `Current avg ${result.currentAvgPercent.toFixed(1)}% vs 7d baseline ${result.baselineAvgPercent.toFixed(1)}% (+${increase}%)`,
        evidence: [evidence("container.cpu", `current=${result.currentAvgPercent.toFixed(1)}% baseline7d=${result.baselineAvgPercent.toFixed(1)}% ratio=${result.ratio.toFixed(2)}`, "7d", "partial")],
        window: "7d",
        confidence: result.confidence,
        firstObserved: nowIso(),
        lastObserved: nowIso(),
        actionable: true,
        deepLink: `/docker/${encodeURIComponent(name)}`,
        recommendation: "Inspect recent config or workload changes for this container.",
      });
    }
  }
  return insights;
}

/* ---- Thermal baseline (Fase 7) ------------------------------------------------------ */

async function buildThermalBaseline(): Promise<Insight[]> {
  const current = await fetchAggregated("max by() (homelab_temperature_celsius)", "7d");
  const prior = await fetchAggregated("max by() (homelab_temperature_celsius)", "30d");
  const weekAgo = Date.now() - 7 * 24 * 3600_000;
  const priorWeek: TrendSample[] = prior.samples.filter((sample) => {
    const t = Date.parse(sample.t);
    return t < weekAgo;
  });
  const baseline = thermalBaseline(current.samples, priorWeek);
  if (baseline.confidence === "insufficient" || !baseline.comparable || baseline.driftVsPriorWeekC == null) {
    return [];
  }
  const drift = baseline.driftVsPriorWeekC;
  if (Math.abs(drift) < 4) return []; // noise band
  return [
    {
      id: "insight:thermal-baseline:host",
      entity: "host",
      type: "trend",
      severity: drift >= 6 ? "watch" : "info",
      title: drift > 0 ? `Idle temperature baseline +${drift.toFixed(0)}°C vs prior week` : `Idle temperature baseline ${drift.toFixed(0)}°C vs prior week`,
      summary: `p50 ${baseline.p50C?.toFixed(0)}°C · p95 ${baseline.p95C?.toFixed(0)}°C · idle baseline ${baseline.idleBaselineC?.toFixed(0)}°C · daily-max trend ${baseline.dailyMaxSlopePerDay != null ? `${baseline.dailyMaxSlopePerDay >= 0 ? "+" : ""}${baseline.dailyMaxSlopePerDay.toFixed(2)}°C/day` : "flat"}`,
      evidence: [evidence("host.temperature", `drift7d=${drift.toFixed(1)}°C p50=${baseline.p50C?.toFixed(1)}°C p95=${baseline.p95C?.toFixed(1)}°C`, "7d", "partial")],
      window: "7d",
      confidence: baseline.confidence,
      firstObserved: nowIso(),
      lastObserved: nowIso(),
      actionable: true,
      deepLink: "/system",
      recommendation: "Check airflow, ambient temperature and sustained workloads.",
    },
  ];
}

/* ---- Incident recurrence (Fase 8) ------------------------------------------------------- */

export function buildRecurrence(now = Date.now()): { summaries: RecurrenceSummary[]; insights: Insight[] } {
  const state = loadIncidentsState();
  const summaries: RecurrenceSummary[] = [];
  const insights: Insight[] = [];
  for (const incident of Object.values(state.incidents)) {
    const opened = incident.timeline.filter((event) => event.event === "incident opened").map((event) => Date.parse(event.at)).sort((a, b) => a - b);
    const recovered = incident.timeline.filter((event) => event.event === "recovered").map((event) => Date.parse(event.at)).sort((a, b) => a - b);
    if (opened.length === 0) {
      if (incident.status === "recovered") opened.push(Date.parse(incident.firstSeenAt));
      else continue; // a still-first-episode active incident is not recurrence
    }

    const in24h = opened.filter((at) => now - at <= 24 * 3600_000).length;
    const in7d = opened.filter((at) => now - at <= 7 * 24 * 3600_000).length;

    const durations: number[] = [];
    let longest = 0;
    for (const start of opened) {
      const end = recovered.find((at) => at >= start) ?? (incident.status === "active" ? now : Date.parse(incident.resolvedAt ?? incident.lastSeenAt));
      const duration = Math.max(0, end - start);
      durations.push(duration);
      longest = Math.max(longest, duration);
    }
    const total = durations.reduce((acc, value) => acc + value, 0);
    const meanDuration = durations.length > 0 ? total / durations.length : null;
    const lastOccurrence = new Date(opened[opened.length - 1]!).toISOString();
    const recurring = in7d >= 3;

    summaries.push({
      entity: incident.entity,
      kind: incident.kind,
      occurrences24h: in24h,
      occurrences7d: in7d,
      totalActiveDurationMs: total,
      meanDurationMs: meanDuration,
      longestDurationMs: longest,
      lastOccurrence,
      recurring,
    });

    if (recurring) {
      const hours = Math.round(total / 3600_000);
      insights.push({
        id: `insight:recurrence:${incident.id}`,
        entity: incident.entity,
        type: "recurrence",
        severity: "watch",
        title: `Recurring: ${incident.title}`,
        summary: `${in7d} occurrences in 7 days, total ${hours >= 1 ? `${hours}h` : `${Math.round(total / 60_000)}m`} active`,
        evidence: [evidence("incidents.history", `opened7d=${in7d} opened24h=${in24h} totalActive=${Math.round(total / 60_000)}m`, "7d", "good", "beacon")],
        window: "7d",
        confidence: in7d >= 5 ? "high" : "medium",
        firstObserved: nowIso(),
        lastObserved: nowIso(),
        actionable: true,
        deepLink: `/incidents/${encodeURIComponent(incident.id)}`,
        recommendation: "Inspect repeated healthcheck failures or the underlying trigger pattern.",
      });
    }
  }
  return { summaries, insights };
}

/* ---- Restart recurrence (Fase 9) ------------------------------------------------------------ */

export interface RestartPoint {
  t: number;
  v: number | null;
}

export interface RestartAnalysis {
  restarts7d: number;
  clusters: number;
  correlated: string | null;
}

/**
 * Pure restart-pattern analysis (deterministic, testable — Fase 9/29):
 * summed hourly change-buckets → total restarts + separated cluster count
 * + deploy correlation. PLANNED restarts (update-machine runs,
 * pipeline-owned projects) never read as crash patterns.
 */
export function analyzeRestartSeries(
  points: RestartPoint[],
  options: { pipelineProjects: string[]; recentUpdateTargets: string[]; name: string },
): RestartAnalysis | null {
  const restarts7d = points.reduce((acc, point) => acc + Math.max(0, point.v ?? 0), 0);
  if (restarts7d < 4) return null; // below pattern threshold — no insight
  const hotHours = points.filter((point) => (point.v ?? 0) > 0);
  let clusters = 0;
  let previous = -10;
  for (const point of hotHours) {
    if (point.t - previous > 6) clusters += 1;
    previous = point.t;
  }
  if (clusters < 3) return null;
  const correlated = options.recentUpdateTargets.includes(options.name)
    ? "correlated with recent updates (planned restarts)"
    : options.pipelineProjects.some((project) => options.name.includes(project))
      ? "pipeline-owned project (planned deploys)"
      : null;
  return { restarts7d, clusters, correlated };
}

/** Pure update-impact builder (Fase 29-13): correlation wording ONLY —
 *  never "caused by the update". */
export function updateImpactInsight(input: {
  target: string;
  startedAt: string;
  updatedAt: number;
  beforeMedian: number | null;
  afterMedian: number | null;
  afterSamples: number;
  beforeSamples: number;
}): Insight | null {
  const { beforeMedian, afterMedian } = input;
  if (beforeMedian == null || afterMedian == null || beforeMedian <= 0) return null;
  const changePercent = ((afterMedian - beforeMedian) / beforeMedian) * 100;
  if (Math.abs(changePercent) < 10) return null; // not notable
  return {
    id: `insight:update-impact:${input.target}:${input.startedAt}`,
    entity: input.target,
    type: "efficiency",
    severity: "info",
    title: `After update: ${input.target}`,
    summary: `After update (${new Date(input.updatedAt).toISOString().slice(0, 16).replace("T", " ")}): memory ${changePercent >= 0 ? "+" : ""}${Math.round(changePercent)}% vs the 24h before — no causality claimed`,
    evidence: [evidence("container.memory", `before24h=${formatBytes(beforeMedian)} after24h=${formatBytes(afterMedian)} change=${Math.round(changePercent)}%`, "7d", "partial")],
    window: "7d",
    confidence: input.afterSamples >= 12 && input.beforeSamples >= 12 ? "medium" : "low",
    firstObserved: new Date(input.updatedAt).toISOString(),
    lastObserved: nowIso(),
    actionable: false,
    deepLink: `/docker/${encodeURIComponent(input.target)}`,
    recommendation: null,
  };
}

/** Fingerprint dedupe (Fase 15): one insight per logical observation. */
export function dedupeInsights(insights: Insight[]): Insight[] {
  const seen = new Set<string>();
  return insights.filter((insight) => (seen.has(insight.id) ? false : (seen.add(insight.id), true)));
}

async function buildRestartInsights(): Promise<Insight[]> {
  if (!isPrometheusConfigured()) return [];
  const insights: Insight[] = [];
  try {
    const prom = getPromClient();
    const now = Date.now();
    const week = await prom.range(
      'sum by (name) (changes(container_start_time_seconds{name!=""}[1h]))',
      Math.floor((now - 7 * 24 * 3600_000) / 1000),
      Math.floor(now / 1000),
      3600,
    );
    const pipelineProjects = (process.env.PIPELINE_OWNED_PROJECTS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    const updateHistory = await readUpdateHistory().catch(() => []);
    const recentUpdateTargets = [
      ...new Set(
        updateHistory
          .filter((entry) => entry.result === "success" && Date.parse(entry.timestamp) > now - 7 * 24 * 3600_000)
          .map((entry) => entry.target ?? ""),
      ).values(),
    ].filter(Boolean);

    for (const series of week) {
      const name = String(series.metric.name ?? "");
      if (!name) continue;
      const analysis = analyzeRestartSeries(
        series.points.map((point) => ({ t: point.t, v: point.v })),
        { pipelineProjects, recentUpdateTargets, name },
      );
      if (!analysis) continue;
      const correlated = analysis.correlated;
      insights.push({
        id: `insight:restarts:${name}`,
        entity: name,
        type: "recurrence",
        severity: correlated ? "info" : "watch",
        title: correlated ? `Frequent planned restarts: ${name}` : `Frequent restarts: ${name}`,
        summary: `${Math.round(analysis.restarts7d)} restarts in 7d across ${analysis.clusters} clustered periods${correlated ? ` — ${correlated}` : ""}`,
        evidence: [evidence("container.start_time", `restarts7d=${Math.round(analysis.restarts7d)} clusters=${analysis.clusters}`, "7d", "partial")],
        window: "7d",
        confidence: "medium",
        firstObserved: nowIso(),
        lastObserved: nowIso(),
        actionable: !correlated,
        deepLink: `/docker/${encodeURIComponent(name)}`,
        recommendation: correlated ? null : "Check container logs for the restarting process; correlate with deploy calendar.",
      });
    }
  } catch {
    // Prometheus unavailable — no restart insights this cycle.
  }
  return insights;
}

/* ---- Update impact (Fase 10) -------------------------------------------------------------------- */

async function buildUpdateImpact(): Promise<Insight[]> {
  const history = await readUpdateHistory().catch(() => []);
  const relevant = history
    .filter((entry) => entry.result === "success" && entry.target && Date.parse(entry.timestamp) > Date.now() - 7 * 24 * 3600_000)
    .slice(0, 3);
  if (relevant.length === 0) return []; // insufficient history — no insight

  const insights: Insight[] = [];
  for (const entry of relevant) {
    const target = entry.target!;
    const updatedAt = Date.parse(entry.timestamp);
    const mem = await fetchAggregated(`container_memory_working_set_bytes{name="${escapePromQL(target)}"}`, "7d");
    const beforeValues = mem.samples
      .filter((sample) => {
        const t = Date.parse(sample.t);
        return t >= updatedAt - 24 * 3600_000 && t < updatedAt && sample.value != null;
      })
      .map((sample) => sample.value as number);
    const afterValues = mem.samples
      .filter((sample) => {
        const t = Date.parse(sample.t);
        return t >= updatedAt && t < updatedAt + 24 * 3600_000 && sample.value != null;
      })
      .map((sample) => sample.value as number);
    const insight = updateImpactInsight({
      target,
      startedAt: entry.startedAt,
      updatedAt,
      beforeMedian: median(beforeValues),
      afterMedian: median(afterValues),
      afterSamples: afterValues.length,
      beforeSamples: beforeValues.length,
    });
    if (insight) insights.push(insight);
  }
  return insights;
}

/* ---- Source performance (Fase 11) -------------------------------------------------------------------- */

function buildSourcePerformance(): SourcePerformanceEntry[] {
  return allSourceLatencyStats(24 * 3600_000).map((stats) => ({
    source: stats.source,
    sampleCount: stats.sampleCount,
    p50Ms: stats.p50Ms,
    p95Ms: stats.p95Ms,
    window: "24h",
    confidence: stats.sampleCount >= 40 ? "high" : stats.sampleCount >= 12 ? "medium" : stats.sampleCount > 0 ? "low" : "insufficient",
  }));
}

/* ---- Cycle --------------------------------------------------------------------------------------------- */

async function runCycle(): Promise<InsightsPayload> {
  await ensureInsightsState();
  const capability = prometheusHistoryCapability();

  if (!capability.available) {
    // No Prometheus: honest empty payload, every range insufficient.
    const payload: InsightsPayload = {
      generatedAt: nowIso(),
      sections: { watchSoon: [], trends: [], capacity: [], recurring: [], performance: [] },
      forecasts: [],
      memoryCreep: [],
      sourcePerformance: buildSourcePerformance(),
      recurrence: buildRecurrence().summaries,
      ranges: (["24h", "7d", "30d"] as TrendRange[]).map((range) => ({
        range,
        available: false,
        reason: capability.reason,
      })),
    };
    return payload;
  }

  const [capacity, memory, cpuDrift, thermal, restarts, updateImpact] = await Promise.all([
    buildCapacity(),
    buildMemoryCreep(),
    buildCpuDrift(),
    buildThermalBaseline(),
    buildRestartInsights(),
    buildUpdateImpact(),
  ]);
  const recurrence = buildRecurrence();

  let insights: Insight[] = [
    ...capacity.insights,
    ...memory.insights,
    ...cpuDrift,
    ...thermal,
    ...recurrence.insights,
    ...restarts,
    ...updateImpact,
  ];

  // Dedupe by fingerprint (Fase 15) + stable identity (firstObserved).
  insights = dedupeInsights(insights);
  for (const insight of insights) applyStableIdentity(insight);
  mergeInsightIdentities(insights);
  scheduleInsightsStateSave();

  // Section assignment (Fase 16): bounded, no dashboard overload.
  const bySeverity = (a: Insight, b: Insight) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  const watchSoon = insights
    .filter((insight) => insight.severity === "warning" || (insight.severity === "watch" && insight.type === "capacity"))
    .sort(bySeverity)
    .slice(0, 5);
  const capacityInsights = insights.filter((insight) => insight.type === "capacity" && !watchSoon.includes(insight)).slice(0, 5);
  const trends = insights.filter((insight) => insight.type === "trend" || insight.type === "degradation").sort(bySeverity).slice(0, 6);
  const recurring = insights.filter((insight) => insight.type === "recurrence").sort(bySeverity).slice(0, 6);
  const performance: Insight[] = [];

  const pushPrefs = getInsightPushPreferences();
  void pushPrefs; // consumed by the notification side (opt-in only)

  return {
    generatedAt: nowIso(),
    sections: { watchSoon, trends, capacity: capacityInsights, recurring, performance },
    forecasts: capacity.forecasts,
    memoryCreep: memory.creep,
    sourcePerformance: buildSourcePerformance(),
    recurrence: recurrence.summaries,
    ranges: (["24h", "7d", "30d"] as TrendRange[]).map((range) => {
      const supported = rangeSupported(range);
      return { range, available: supported.ok && capability.available, reason: supported.reason ?? capability.reason };
    }),
  };
}

const SEVERITY_RANK: Record<InsightSeverity, number> = { warning: 2, watch: 1, info: 0 };

export function currentInsights(): InsightsPayload {
  return (
    globalStore.__insightsSnapshot ?? {
      generatedAt: nowIso(),
      sections: { watchSoon: [], trends: [], capacity: [], recurring: [], performance: [] },
      forecasts: [],
      memoryCreep: [],
      sourcePerformance: buildSourcePerformance(),
      recurrence: [],
      ranges: (["24h", "7d", "30d"] as TrendRange[]).map((range) => ({
        range,
        available: false,
        reason: "not evaluated yet",
      })),
    }
  );
}

/** Single-flight, TTL-gated cycle. Never throws; serves the last snapshot. */
export async function runInsightsCycle(force = false): Promise<InsightsPayload> {
  if (globalStore.__insightsBusy) return currentInsights();
  if (!force && globalStore.__insightsCycleAt && Date.now() - globalStore.__insightsCycleAt < CYCLE_MIN_INTERVAL_MS) {
    return currentInsights();
  }
  globalStore.__insightsBusy = true;
  try {
    const payload = await runCycle();
    globalStore.__insightsSnapshot = payload;
    globalStore.__insightsCycleAt = Date.now();
    return payload;
  } catch {
    return currentInsights();
  } finally {
    globalStore.__insightsBusy = false;
  }
}

export function resetInsightsCycleCache(): void {
  globalStore.__insightsSnapshot = undefined;
  globalStore.__insightsCycleAt = undefined;
  resetInsightsRangeCache();
}
