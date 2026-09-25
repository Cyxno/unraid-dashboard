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
