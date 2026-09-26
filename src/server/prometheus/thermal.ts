import {
  PACKAGE_TEMP_FALLBACK_QUERY,
  POWER_WATTS_QUERY,
  TEMPERATURES_QUERY,
  TEMPERATURE_RANGE_WINDOW,
} from "./queries";
import { withCache, type PromClient } from "./client";
import type {
  HistoryPoint,
  LiveStatus,
  MetricMeta,
  NamedSeries,
  ThermalCategory,
  ThermalSensor,
  ThermalSnapshot,
} from "@/lib/api-types";

/**
 * Thermal observability. Primary source is homelab-exporter's
 * `homelab_temperature_celsius{chip,sensor}` — verified on this host with
 * human-readable sensor names (coretemp "Package id 0", "Core 0..N",
 * acpitz "temp1"). node-exporter's x86_pkg_temp thermal zone is used as
 * a package-temp fallback only.
 *
 * There are no fan-RPM or NVMe sensors exposed by any exporter on this
 * host — those categories simply never appear (nothing is invented).
 */

export function classifySensor(
  chip: string,
  sensor: string,
): ThermalCategory {
  const lower = sensor.toLowerCase();
  const chipLower = chip.toLowerCase();
  if (chipLower.includes("coretemp")) {
    if (lower.includes("package")) return "package";
    if (lower.includes("core")) return "core";
  }
  if (chipLower.includes("nvme")) return "disk";
  if (chipLower.includes("acpitz") || chipLower.includes("motherboard"))
    return "board";
  if (lower.includes("package")) return "package";
  if (lower.includes("core")) return "core";
  if (lower.includes("nvme")) return "disk";
  return "other";
}

function sensorId(chip: string, sensor: string): string {
  return `${chip}/${sensor.replace(/\s+/g, "_")}`;
}

function meta(
  status: LiveStatus,
  reason?: string,
): MetricMeta {
  return {
    source: "prometheus",
    status,
    sampledAt: new Date().toISOString(),
    reason,
  };
}

function pickNumber(
  samples: Array<{ v: number | null }>,
): number | null {
  for (const sample of samples) {
    if (sample.v !== null) return sample.v;
  }
  return null;
}

/** Current thermal snapshot with classified sensors. Cached 3s. */
export async function getThermalSnapshot(
  client: PromClient,
): Promise<ThermalSnapshot> {
  return withCache("thermal:snapshot", 3_000, async () => {
    const [samples, fallback, power] = await Promise.all([
      client.instant(TEMPERATURES_QUERY),
      client.instant(PACKAGE_TEMP_FALLBACK_QUERY).catch(() => []),
      client.instant(POWER_WATTS_QUERY).catch(() => []),
    ]);

    const sensors: ThermalSensor[] = samples
      .map((sample) => {
        const chip = sample.metric.chip ?? "unknown";
        const name = sample.metric.sensor ?? chip;
        return {
          id: sensorId(chip, sample.metric.sensor ?? chip),
          name,
          chip,
          category: classifySensor(chip, name),
          currentC: sample.v,
        };
      })
      .sort((a, b) => (b.currentC ?? -273) - (a.currentC ?? -273));

    // Fallback package temp when homelab-exporter reports none.
    if (!sensors.some((sensor) => sensor.category === "package")) {
      const fallbackValue = pickNumber(fallback);
      if (fallbackValue !== null) {
        sensors.push({
          id: "x86_pkg_temp",
          name: "Package (x86_pkg_temp)",
          chip: "thermal_zone",
          category: "package",
          currentC: fallbackValue,
        });
      }
    }

    const packageC =
      sensors.find((sensor) => sensor.category === "package")?.currentC ?? null;
    const boardC =
      sensors.find((sensor) => sensor.category === "board")?.currentC ?? null;
    const hottest = sensors[0] ?? null;

    return {
      packageC,
      boardC,
      hottestC: hottest?.currentC ?? null,
      hottestName: hottest?.name ?? null,
      powerWatts: pickNumber(power),
      sensors,
    };
  });
}

/** Hottest package reading over a window (uses Prometheus max_over_time). */
export async function getPackagePeak(
  client: PromClient,
  windowSeconds: number,
): Promise<number | null> {
  return withCache(`thermal:peak:${windowSeconds}`, 30_000, async () => {
    const samples = await client.instant(
      TEMPERATURE_RANGE_WINDOW(`${Math.floor(windowSeconds)}s`),
    );
    // Only the package-classified sensor matters; filter by label.
    const packageSamples = samples.filter(
      (sample) =>
        (sample.metric.chip ?? "").toLowerCase().includes("coretemp") &&
        (sample.metric.sensor ?? "").toLowerCase().includes("package"),
    );
    const values = (packageSamples.length > 0 ? packageSamples : samples)
      .map((sample) => sample.v)
      .filter((value): value is number => value !== null);
    return values.length > 0 ? Math.max(...values) : null;
  });
}

export interface ThermalHistory {
  meta: MetricMeta;
  series: NamedSeries[];
  /** Per-sensor min/max over the window. */
  stats: Array<{
    id: string;
    name: string;
    category: ThermalCategory;
    min: number | null;
    max: number | null;
    current: number | null;
  }>;
}

/** Per-sensor temperature history over a range. */
export async function getThermalHistory(
  client: PromClient,
  query: string,
  startSeconds: number,
  endSeconds: number,
  stepSeconds: number,
): Promise<ThermalHistory> {
  const matrix = await client.range(
    query,
    startSeconds,
    endSeconds,
    stepSeconds,
  );
  const series: NamedSeries[] = [];
  const stats: ThermalHistory["stats"] = [];
  for (const entry of matrix) {
    const chip = entry.metric.chip ?? "unknown";
    const name = entry.metric.sensor ?? chip;
    const points: HistoryPoint[] = entry.points.map((point) => ({
      t: point.t * 1000,
      v: point.v,
    }));
    series.push({
      name,
      labels: { chip },
      points,
    });
    const values = points
      .map((point) => point.v)
      .filter((value): value is number => value !== null);
    stats.push({
      id: sensorId(chip, name),
      name,
      category: classifySensor(chip, name),
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      current: points.at(-1)?.v ?? null,
    });
  }
  series.sort((a, b) => a.name.localeCompare(b.name));
  stats.sort(
    (a, b) => (b.max ?? -273) - (a.max ?? -273),
  );
  return { meta: meta("live"), series, stats };
}

/** Normalizes a PrometheusError into a meta block for graceful UI. */
export function thermalErrorMeta(error: unknown): MetricMeta {
  return meta(
    "unavailable",
    error instanceof Error ? error.message : "thermal metrics unavailable",
  );
}

/* v0.6: thermal diagnostics ---------------------------------------------------
 * 24h package-temperature diagnostics built on Prometheus range data:
 * duration buckets, sustained episodes (hysteresis, no spikes), load and
 * power correlation (associative only), and an hourly timeline. All math
 * lives in thermal-diagnostics.ts (pure, unit-tested); this module only
 * fetches series and assembles the payload. Cached 60s.
 */

import {
  alignSeries,
  buildBuckets,
  buildHourlyTimeline,
  classifyEpisode,
  describeCorrelation,
  detectThermalEpisodes,
  pearsonCorrelation,
  topContainersInRange,
  type TempSeriesPoint,
  type ThermalEpisode,
  type TempBuckets,
  type ThermalTimelineHour,
} from "./thermal-diagnostics";
import {
  CPU_TEMP_CRITICAL_C,
  CPU_TEMP_WARNING_C,
} from "@/server/thresholds";

/** True CPU package power zone (verified on this host via RAPL). */
const PACKAGE_POWER_QUERY = 'homelab_power_watts{zone="package-0"}';
const SYSTEM_POWER_QUERY = 'homelab_power_watts{zone="psys"}';
const HOST_CPU_RANGE_QUERY =
  '100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}[2m])))';

export interface ThermalDiagnostics {
  meta: MetricMeta;
  /** Window this attribution covers. */
  attributionWindow: AttributionWindow;
  /** °C thresholds used for every judgment here (centralized). */
  thresholds: { warningC: number; criticalC: number };
  sensor: { name: string; chip: string } | null;
  currentC: number | null;
  averages: {
    avg5mC: number | null;
    avg15mC: number | null;
    avg1hC: number | null;
    avg24hC: number | null;
  };
  maxima: { max1hC: number | null; max6hC: number | null; max24hC: number | null };
  median24hC: number | null;
  /** Approximate minutes at/above thresholds over 24h. */
  minutesAboveWarning: number | null;
  minutesAboveCritical: number | null;
  /** 24h temperature distribution across fixed duration buckets. */
  buckets: TempBuckets | null;
  /** Sustained episodes (never single-sample spikes). */
  episodes: ThermalEpisode[];
  /** Associative Pearson correlations (no causal claim). */
  correlation: {
    tempVsCpu: number | null;
    tempVsCpuLabel: string;
    tempVsPower: number | null;
    tempVsPowerLabel: string;
    /** Downsampled aligned series for the scatter/overlay chart. */
    points: Array<{ t: number; tempC: number; cpuPercent: number; powerWatts: number | null }>;
    powerZone: "package-0" | "psys" | null;
  };
  timeline: ThermalTimelineHour[];
  /** Peak package/system power over 24h (W). */
  peakPowerWatts24h: number | null;
}

async function instantValue(client: PromClient, query: string): Promise<number | null> {
  try {
    const samples = await client.instant(query);
    return samples.find((sample) => sample.v !== null)?.v ?? null;
  } catch {
    return null;
  }
}

async function rangeSeries(
  client: PromClient,
  query: string,
  windowSeconds: number,
  stepSeconds: number,
): Promise<TempSeriesPoint[]> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - windowSeconds;
  try {
    const matrix = await client.range(query, start, end, stepSeconds);
    // Single-series selectors: flatten the first result.
    const entry = matrix[0];
    if (!entry) return [];
    return entry.points.map((point) => ({ t: point.t, v: point.v }));
  } catch {
    return [];
  }
}

export type AttributionWindow = "1h" | "6h" | "24h";

const ATTRIBUTION_WINDOWS: Record<AttributionWindow, number> = {
  "1h": 3600,
  "6h": 6 * 3600,
  "24h": 24 * 3600,
};

export async function getThermalDiagnostics(
  client: PromClient,
  attributionWindow: AttributionWindow = "24h",
): Promise<ThermalDiagnostics> {
  // Cache key includes the window so 1h/6h/24h views never share entries;
  // step scales with the window to bound query cost (§28).
  return withCache(
    `thermal:diagnostics:${attributionWindow}`,
    60_000,
    async () => {
    const warningC = CPU_TEMP_WARNING_C;
    const criticalC = CPU_TEMP_CRITICAL_C;
    const windowSeconds = ATTRIBUTION_WINDOWS[attributionWindow];

    const label = PACKAGE_SENSOR_LABEL;
    const base = (await instantValue(client, label)) !== null ? label : PACKAGE_FALLBACK_LABEL;

    // Instant stats (Prometheus aggregates; cached per-query upstream).
    const [current, avg5m, avg15m, avg1h, max1h, max6h, max24h, avg24h, median24h, aboveWarn, aboveCrit] =
      await Promise.all([
        instantValue(client, `${base}`),
        instantValue(client, `avg_over_time(${base}[5m])`),
        instantValue(client, `avg_over_time(${base}[15m])`),
        instantValue(client, `avg_over_time(${base}[1h])`),
        instantValue(client, `max_over_time(${base}[1h])`),
        instantValue(client, `max_over_time(${base}[6h])`),
        instantValue(client, `max_over_time(${base}[24h])`),
        instantValue(client, `avg_over_time(${base}[24h])`),
        instantValue(client, `quantile_over_time(0.5, ${base}[24h])`),
        instantValue(client, `sum_over_time((${base} > bool ${warningC})[24h:1m])`),
        instantValue(client, `sum_over_time((${base} > bool ${criticalC})[24h:1m])`),
      ]);

    // Range series for buckets/episodes/correlation; step scales with the
    // window (60s/1h, 120s/6h, 300s/24h) to keep query cost bounded.
    const rangeStep = attributionWindow === "1h" ? 60 : attributionWindow === "6h" ? 120 : 300;
    const [tempRange, cpuRange, powerRange] = await Promise.all([
      rangeSeries(client, base, windowSeconds, rangeStep),
      rangeSeries(client, HOST_CPU_RANGE_QUERY, windowSeconds, rangeStep),
      rangeSeries(client, PACKAGE_POWER_QUERY, windowSeconds, rangeStep).then(async (series) => {
        if (series.length > 0) return { series, zone: "package-0" as const };
        const psys = await rangeSeries(client, SYSTEM_POWER_QUERY, windowSeconds, rangeStep);
        return { series: psys, zone: psys.length > 0 ? ("psys" as const) : null };
      }),
    ]);

    const buckets = buildBuckets(tempRange, windowSeconds);

    const episodes = detectThermalEpisodes(tempRange);

    // Correlate aligned samples.
    const tempCpuPairs = alignSeries(tempRange, cpuRange);
    const tempPowerPairs = alignSeries(tempRange, powerRange.series);
    const tempVsCpu = pearsonCorrelation(tempCpuPairs.map((pair) => ({ av: pair.av, bv: pair.bv })));
    const tempVsPower = pearsonCorrelation(tempPowerPairs.map((pair) => ({ av: pair.av, bv: pair.bv })));

    // Downsample aligned chart points (~5-minute spacing → ≤288 points).
    const cpuByTime = new Map(cpuRange.filter((p) => p.v !== null).map((p) => [p.t, p.v as number]));
    const powerByTime = new Map(powerRange.series.filter((p) => p.v !== null).map((p) => [p.t, p.v as number]));
    const chartPoints = tempRange
      .filter((point) => point.v !== null)
      .filter((_, index) => index % 5 === 0)
      .map((point) => ({
        t: point.t * 1000,
        tempC: point.v as number,
        cpuPercent: cpuByTime.get(point.t) ?? null,
        powerWatts: powerByTime.get(point.t) ?? null,
      }))
      .filter((point): point is { t: number; tempC: number; cpuPercent: number; powerWatts: number | null } =>
        point.cpuPercent !== null,
      );

    // Episode CPU/power stats via aligned series within bounds.
    const cpuPoints = tempCpuPairs;
    const powerPoints = tempPowerPairs;

    // Per-container CPU history for episode attribution (v0.7). One range
    // query over all name-keyed container CPU series at 5m step; a series
    // must have ≥2 in-range samples to count (no fabricated attribution).
    let containerCpuSeries = new Map<string, Array<{ t: number; v: number | null }>>();
    try {
      const matrix = await client.range("docker_stats_cpu_percent", Math.floor(Date.now() / 1000) - windowSeconds, Math.floor(Date.now() / 1000), rangeStep);
      for (const entry of matrix) {
        const name = entry.metric.name;
        if (!name) continue;
        containerCpuSeries.set(name, entry.points.map((point) => ({ t: point.t, v: point.v })));
      }
    } catch {
      containerCpuSeries = new Map();
    }

    for (const episode of episodes) {
      const endT = episode.endMs ?? Date.now();
      const inEpisodeCpu = cpuPoints.filter(
        (pair) => pair.t * 1000 >= episode.startMs && pair.t * 1000 <= endT,
      );
      const inEpisodePower = powerPoints.filter(
        (pair) => pair.t * 1000 >= episode.startMs && pair.t * 1000 <= endT,
      );
      if (inEpisodeCpu.length > 0) {
        episode.avgCpuPercent =
          Math.round((inEpisodeCpu.reduce((sum, pair) => sum + pair.bv, 0) / inEpisodeCpu.length) * 10) / 10;
        episode.peakCpuPercent = Math.round(Math.max(...inEpisodeCpu.map((pair) => pair.bv)) * 10) / 10;
      }
      if (inEpisodePower.length > 0) {
        episode.avgPowerWatts =
          Math.round((inEpisodePower.reduce((sum, pair) => sum + pair.bv, 0) / inEpisodePower.length) * 10) / 10;
        episode.peakPowerWatts = Math.round(Math.max(...inEpisodePower.map((pair) => pair.bv)) * 10) / 10;
      }
      // Attribution: per-episode correlations + top CPU containers.
      const episodeTempCpu = pearsonCorrelation(
        inEpisodeCpu.map((pair) => ({ av: pair.av, bv: pair.bv })),
      );
      const episodeTempPower = pearsonCorrelation(
        inEpisodePower.map((pair) => ({ av: pair.av, bv: pair.bv })),
      );
      episode.tempVsCpu = episodeTempCpu;
      episode.tempVsPower = episodeTempPower;
      episode.classification = classifyEpisode({
        avgCpuPercent: episode.avgCpuPercent,
        tempVsCpu: episodeTempCpu,
        tempVsPower: episodeTempPower,
      });
      episode.topContainers = topContainersInRange(
        containerCpuSeries,
        Math.floor(episode.startMs / 1000),
        Math.floor(endT / 1000),
        3,
      );
    }

    const peakPowerWatts24h =
      powerRange.series.length > 0
        ? Math.round(Math.max(...powerRange.series.map((point) => point.v ?? -Infinity)) * 10) / 10
        : null;

    return {
      meta:
        buckets.sampleCount === 0 && current === null
          ? meta("unavailable", "No 24h temperature data available.")
          : meta("live"),
      thresholds: { warningC, criticalC },
      sensor:
        base === PACKAGE_SENSOR_LABEL
          ? { name: "Package id 0", chip: "coretemp" }
          : { name: "x86_pkg_temp", chip: "thermal_zone" },
      currentC: current,
      averages: { avg5mC: avg5m, avg15mC: avg15m, avg1hC: avg1h, avg24hC: avg24h },
      maxima: { max1hC: max1h, max6hC: max6h, max24hC: max24h },
      median24hC: median24h,
      minutesAboveWarning: aboveWarn,
      minutesAboveCritical: aboveCrit,
      buckets,
      episodes,
      correlation: {
        tempVsCpu,
        tempVsCpuLabel: describeCorrelation(tempVsCpu),
        tempVsPower,
        tempVsPowerLabel: describeCorrelation(tempVsPower),
        points: chartPoints,
        powerZone: powerRange.zone,
      },
      timeline: buildHourlyTimeline(tempRange),
      peakPowerWatts24h,
      attributionWindow,
    };
    },
  );
}

/** Normalizes a diagnostics failure into an unavailable-meta payload. */
export function thermalDiagnosticsErrorMeta(error: unknown): MetricMeta {
  return thermalErrorMeta(error);
}

/* v0.5: 24h thermal analysis ------------------------------------------------
 * Definitions (documented in README):
 * - max/avg/median over the window: Prometheus aggregate functions.
 * - "time above threshold": sum_over_time of the bool comparison at a
 *   1-minute subquery step → approximate minutes at the scrape cadence.
 * - spike vs sustained: current reading compared with the 5-minute
 *   average. A momentary peak above threshold with a cool 5m average is
 *   reported as a spike, never as sustained pressure.
 * No throttle counters exist on this host — none of this implies
 * throttling.
 */

export interface ThermalAnalysis {
  sensor: { name: string; chip: string } | null;
  currentC: number | null;
  avg5mC: number | null;
  max1hC: number | null;
  max24hC: number | null;
  avg24hC: number | null;
  median24hC: number | null;
  /** Approximate minutes at/above each threshold over 24h. */
  minutesAboveWarning: number | null;
  minutesAboveCritical: number | null;
  /** Honest classification of the current reading. */
  state: "normal" | "elevated" | "sustained-high" | "critical" | "spike" | "unknown";
  explanation: string;
}

const PACKAGE_SENSOR_LABEL = 'homelab_temperature_celsius{chip="coretemp",sensor="Package id 0"}';
export { PACKAGE_SENSOR_LABEL };
const PACKAGE_FALLBACK_LABEL = 'node_thermal_zone_temp{type="x86_pkg_temp"}';

export async function getThermalAnalysis(
  client: PromClient,
  warningC: number,
  criticalC: number,
): Promise<ThermalAnalysis> {
  return withCache("thermal:analysis", 60_000, async () => {
    const label = PACKAGE_SENSOR_LABEL;
    const fallbackLabel = PACKAGE_FALLBACK_LABEL;
    const pick = async (query: string): Promise<number | null> => {
      try {
        const samples = await client.instant(query);
        const value = samples.find((sample) => sample.v !== null)?.v ?? null;
        if (value !== null) return value;
      } catch {
        // fall through to fallback selector where applicable
      }
      return null;
    };

    const current = await pick(`${label}`);
    const usedFallback = current === null;
    const base = usedFallback ? fallbackLabel : label;

    const [avg5m, max1h, max24h, avg24h, median24h, aboveWarn, aboveCrit] =
      await Promise.all([
        pick(`avg_over_time(${base}[5m])`),
        pick(`max_over_time(${base}[1h])`),
        pick(`max_over_time(${base}[24h])`),
        pick(`avg_over_time(${base}[24h])`),
        pick(`quantile_over_time(0.5, ${base}[24h])`),
        pick(`sum_over_time((${base} > bool ${warningC})[24h:1m])`),
        pick(`sum_over_time((${base} > bool ${criticalC})[24h:1m])`),
      ]);

    let state: ThermalAnalysis["state"] = "unknown";
    let explanation = "Thermal data unavailable.";
    if (current !== null) {
      if (current >= criticalC) {
        state = "critical";
        explanation = `At or above the critical threshold (${criticalC}°C).`;
      } else if (avg5m !== null && avg5m >= warningC) {
        state = "sustained-high";
        explanation = `Sustained: the 5-minute average (${avg5m.toFixed(1)}°C) is above the warning threshold (${warningC}°C).`;
      } else if (current >= warningC) {
        state = "spike";
        explanation = `Momentary spike: current ${Math.round(current)}°C is above ${warningC}°C but the 5-minute average (${avg5m !== null ? avg5m.toFixed(1) : "?"}°C) is not.`;
      } else if (current >= warningC - 10) {
        state = "elevated";
        explanation = "Warm but below the warning threshold.";
      } else {
        state = "normal";
        explanation = "Within the normal range.";
      }
    }

    return {
      sensor: usedFallback
        ? { name: "x86_pkg_temp", chip: "thermal_zone" }
        : { name: "Package id 0", chip: "coretemp" },
      currentC: current,
      avg5mC: avg5m,
      max1hC: max1h,
      max24hC: max24h,
      avg24hC: avg24h,
      median24hC: median24h,
      minutesAboveWarning: aboveWarn,
      minutesAboveCritical: aboveCrit,
      state,
      explanation,
    };
  });
}
