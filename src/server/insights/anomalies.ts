import type { Confidence, MemoryCreepInsight, TrendRange, TrendSample } from "@/lib/api-types";
import { linearTrend, mean, median, percentile, seriesStats } from "./timeseries";

/**
 * Deterministic anomaly detection (v1.6.0 Fase 4-7). Simple statistics
 * only: rolling median, MAD, percentile bands, moving averages. NO ML.
 *
 * Hard rules baked in:
 * - one anomalous sample NEVER opens anything (persistence required);
 * - memory high != leak — only a sustained, significant SLOPE over the
 *   window is reported, and only with its confidence;
 * - CPU drift is reported only when the HOST workload does not explain it;
 * - thermal baselines compare like-for-like windows.
 */

/* ---- Memory creep (Fase 5) --------------------------------------------- */

export interface MemoryCreepInput {
  entity: string;
  samples: TrendSample[];
  range: TrendRange;
  liveBytes: number | null;
}

const CREEP_MIN_MOVE_FRACTION = 0.15; // total move ≥ 15% of the span
const CREEP_MIN_FIT = 0.6;
const CREEP_MIN_POINTS = 12;

export function detectMemoryCreep(input: MemoryCreepInput): MemoryCreepInsight | null {
  const { samples, range } = input;
  const trend = linearTrend(samples, range);
  if (trend.direction !== "rising" || trend.confidence === "insufficient") return null;
  if (trend.sampleCount < CREEP_MIN_POINTS || trend.fit == null || trend.fit < CREEP_MIN_FIT) return null;

  const values = samples.filter((sample) => sample.value != null).map((sample) => sample.value as number);
  if (values.length < CREEP_MIN_POINTS) return null;
  const span = Math.max(...values) - Math.min(...values);
  const totalMove = (trend.slopePerDay ?? 0) * (range === "24h" ? 1 : range === "7d" ? 7 : 30);
  if (span <= 0 || Math.abs(totalMove) / span < CREEP_MIN_MOVE_FRACTION) return null;

  const start = values[0]!;
  const current = input.liveBytes ?? values[values.length - 1]!;
  const delta = current - start;
  const slopePerHour = (trend.slopePerDay ?? 0) / 24;
  // A creep worth mentioning moves at least ~0.1% of the window span per
  // hour AND at least 32 MiB over the window — noise never qualifies.
  if (Math.abs(delta) < 32 * 1024 * 1024) return null;

  const confidence: Confidence = trend.confidence;
  const summary =
    `Memory usage has increased consistently over ${range === "24h" ? "24h" : range}` +
    ` (+${formatBytes(delta)}, ~${formatBytes(Math.abs(slopePerHour))}/hour)`;

  return {
    entity: input.entity,
    startBytes: start,
    currentBytes: current,
    deltaBytes: delta,
    slopeBytesPerHour: slopePerHour,
    window: range,
    confidence,
    summary,
  };
}

/* ---- CPU baseline drift (Fase 6) ---------------------------------------- */

export interface CpuDriftInput {
  entity: string;
  /** Current-window samples (e.g. last 24h). */
  currentSamples: TrendSample[];
  /** Baseline-window samples (e.g. the 7d before it). */
  baselineSamples: TrendSample[];
  /** Host CPU over the same current window, for the workload guard. */
  hostCurrentAvgPercent: number | null;
  hostBaselineAvgPercent: number | null;
}

export interface CpuDriftResult {
  entity: string;
  currentAvgPercent: number | null;
  baselineAvgPercent: number | null;
  ratio: number | null;
  confidence: Confidence;
  suppressedReason: string | null;
}

const DRIFT_MIN_RATIO = 1.5; // ≥ +50% vs own baseline
const DRIFT_ABS_MIN = 2; // and at least 2 percentage points
const DRIFT_MIN_POINTS = 10;

export function detectCpuDrift(input: CpuDriftInput): CpuDriftResult {
  const current = mean(input.currentSamples.filter((sample) => sample.value != null).map((sample) => sample.value as number));
  const baseline = mean(input.baselineSamples.filter((sample) => sample.value != null).map((sample) => sample.value as number));
  const currentPoints = input.currentSamples.filter((sample) => sample.value != null).length;
  const baselinePoints = input.baselineSamples.filter((sample) => sample.value != null).length;

  const insufficient =
    current == null || baseline == null || currentPoints < DRIFT_MIN_POINTS || baselinePoints < DRIFT_MIN_POINTS;
  if (insufficient) {
    return { entity: input.entity, currentAvgPercent: current, baselineAvgPercent: baseline, ratio: null, confidence: "insufficient", suppressedReason: "insufficient history" };
  }

  const ratio = baseline > 0 ? current / baseline : null;
  // Workload guard: if the HOST rose at least as much, the container is
  // explained by overall load — no drift claim (Fase 6).
  if (input.hostCurrentAvgPercent != null && input.hostBaselineAvgPercent != null && input.hostBaselineAvgPercent > 0) {
    const hostRatio = input.hostCurrentAvgPercent / input.hostBaselineAvgPercent;
    if (ratio != null && hostRatio >= ratio * 0.8) {
      return { entity: input.entity, currentAvgPercent: current, baselineAvgPercent: baseline, ratio, confidence: "low", suppressedReason: "explained by host workload" };
    }
  }
  if (ratio == null || ratio < DRIFT_MIN_RATIO || current - baseline < DRIFT_ABS_MIN) {
    return { entity: input.entity, currentAvgPercent: current, baselineAvgPercent: baseline, ratio, confidence: "low", suppressedReason: null };
  }
  const confidence: Confidence = currentPoints >= 20 && baselinePoints >= 40 ? "high" : currentPoints >= DRIFT_MIN_POINTS && baselinePoints >= 20 ? "medium" : "low";
  return { entity: input.entity, currentAvgPercent: current, baselineAvgPercent: baseline, ratio, confidence, suppressedReason: null };
}

/* ---- Thermal baseline (Fase 7) ------------------------------------------- */

export interface ThermalBaseline {
  idleBaselineC: number | null;
  p50C: number | null;
  p95C: number | null;
  hottestPeriodC: number | null;
  /** Daily-max trend: slope of the daily maxima, °C/day. */
  dailyMaxSlopePerDay: number | null;
  driftVsPriorWeekC: number | null;
  confidence: Confidence;
  comparable: boolean;
}

export function thermalBaseline(
  currentWeekSamples: TrendSample[],
  priorWeekSamples: TrendSample[] | null,
): ThermalBaseline {
  const currentValues = currentWeekSamples.filter((sample) => sample.value != null).map((sample) => sample.value as number);
  const p50 = percentile(currentValues, 50);
  const p95 = percentile(currentValues, 95);
  // Idle baseline = 10th percentile (the coolest decile of the window).
  const idle = percentile(currentValues, 10);
  const hottest = currentValues.length > 0 ? Math.max(...currentValues) : null;

  const byDay = new Map<string, number[]>();
  for (const sample of currentWeekSamples) {
    if (sample.value == null) continue;
    const day = sample.t.slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), sample.value]);
  }
  const days = [...byDay.keys()].sort();
  const dailyMaxima = days.map((day) => Math.max(...byDay.get(day)!));
  const maxTrend =
    dailyMaxima.length >= 4
      ? linearTrend(
          dailyMaxima.map((value, index) => ({
            t: new Date(Date.parse(days[0]!) + index * 86_400_000).toISOString(),
            value,
            quality: "good" as const,
          })),
          "7d",
        )
      : null;

  let drift: number | null = null;
  let comparable = false;
  if (priorWeekSamples) {
    const priorValues = priorWeekSamples.filter((sample) => sample.value != null).map((sample) => sample.value as number);
    const priorP50 = percentile(priorValues, 50);
    if (priorP50 != null && p50 != null && priorValues.length >= 100 && currentValues.length >= 100) {
      drift = p50 - priorP50;
      comparable = true;
    }
  }

  const enough = currentValues.length >= 100;
  return {
    idleBaselineC: idle,
    p50C: p50,
    p95C: p95,
    hottestPeriodC: hottest,
    dailyMaxSlopePerDay: maxTrend?.slopePerDay ?? null,
    driftVsPriorWeekC: drift,
    confidence: enough ? (comparable ? "medium" : "low") : "insufficient",
    comparable,
  };
}

function formatBytes(bytes: number): string {
  const abs = Math.abs(bytes);
  if (abs >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (abs >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(0)} MiB`;
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

/* ---- Generic robust deviation (Fase 4 helper) ---------------------------- */

/** Rolling median + MAD deviation of the last value vs its own history. */
export function robustDeviation(samples: TrendSample[]): { median: number | null; mad: number | null; last: number | null; deviationRatio: number | null } {
  const values = samples.filter((sample) => sample.value != null).map((sample) => sample.value as number);
  const last = values.length > 0 ? values[values.length - 1]! : null;
  const med = median(values);
  if (med == null || last == null) return { median: med, mad: null, last, deviationRatio: null };
  const deviations = values.map((value) => Math.abs(value - med));
  const mad = median(deviations);
  const deviationRatio = mad != null && mad > 0 ? Math.abs(last - med) / mad : null;
  return { median: med, mad, last, deviationRatio };
}

// seriesStats re-export keeps the anomaly module self-contained for tests.
export { seriesStats };
