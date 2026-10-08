import type { CapacityForecast, Confidence, TrendRange, TrendSample } from "@/lib/api-types";
import { linearTrend } from "./timeseries";

/**
 * Capacity forecast (v1.6.0 Fase 3) with safety rails (Fase 23).
 *
 * Forecasts are ranges, never alarmist exact dates:
 * - flat/noisy/insufficient trends → "trend unavailable" / insufficient
 * - medium confidence → a RANGE ("~2–4 weeks") derived from the slope
 *   with ±40% slack, never a single date
 * - low confidence → direction only, no ETA at all
 *
 * Thresholds: 80% (watch) / 90% (soon) / 95% (critical).
 */

export const CAPACITY_THRESHOLDS = [80, 90, 95] as const;

/** Minimum usage-percentage growth over the window before any ETA. */
const MIN_MOVE_PERCENT_PER_WEEK = 0.25;

export interface ForecastInput {
  entity: string;
  label: string;
  samples: TrendSample[];
  range: TrendRange;
  /** Current usage percent (live value, preferred over last bucket). */
  currentPercent: number | null;
  recommendation: string | null;
}

/** Builds the storage capacity forecast for one filesystem entity. */
export function forecastCapacity(input: ForecastInput): CapacityForecast {
  const { samples, range } = input;
  const trend = linearTrend(samples, range);
  const lastGood = [...samples].reverse().find((sample) => sample.value != null);
  const current = input.currentPercent ?? (lastGood?.value ?? null);

  const base: CapacityForecast = {
    entity: input.entity,
    label: input.label,
    metric: "storage-usage-percent",
    current,
    growthPerDay: trend.direction === "rising" ? trend.slopePerDay : trend.slopePerDay,
    growthPerWeek: trend.slopePerDay != null ? trend.slopePerDay * 7 : null,
    window: range,
    projectedThreshold: 90,
    projectedThresholdFrom: null,
    projectedThresholdTo: null,
    summary: trend.direction === "flat" ? "Usage stable" : "trend unavailable",
    confidence: trend.confidence,
    sampleCount: trend.sampleCount,
    dataQuality: trend.quality,
    recommendation: input.recommendation,
  };

  if (trend.confidence === "insufficient" || trend.quality === "missing" || trend.quality === "stale") {
    return { ...base, summary: "insufficient history", growthPerDay: null, growthPerWeek: null, confidence: "insufficient" };
  }

  const slope = trend.slopePerDay;
  if (slope == null || !Number.isFinite(slope)) {
    return { ...base, summary: "trend unavailable" };
  }

  if (slope <= 0 || trend.direction !== "rising") {
    return {
      ...base,
      summary: slope < 0 ? "Usage is falling — no capacity concern" : "Usage stable",
      projectedThreshold: 90,
    };
  }

  const movePerWeek = slope * 7;
  if (movePerWeek < MIN_MOVE_PERCENT_PER_WEEK) {
    return { ...base, summary: "Usage stable (negligible growth)" };
  }

  // ETA range against the nearest unmet threshold.
  const thresholds = CAPACITY_THRESHOLDS.filter((threshold) => (current ?? 0) < threshold);
  if (thresholds.length === 0) {
    return { ...base, summary: `Usage already above ${CAPACITY_THRESHOLDS[CAPACITY_THRESHOLDS.length - 1]}%`, projectedThreshold: 95 };
  }
  const threshold = thresholds[0]!;
  const daysToThreshold = (threshold - (current ?? 0)) / slope;
  if (!Number.isFinite(daysToThreshold) || daysToThreshold <= 0 || daysToThreshold > 365 * 2) {
    return { ...base, summary: `Rising ${movePerWeek.toFixed(1)}%/week — ${threshold}% far beyond the forecast window`, projectedThreshold: threshold };
  }

  const now = Date.now();
  const fromDays = daysToThreshold * 0.7; // slope ±30% band → date range
  const toDays = daysToThreshold * 1.3;

  let summary: string;
  if (trend.confidence === "high") {
    summary = `Current trend would reach ${threshold}% in ~${humanDays(daysToThreshold)}`;
  } else if (trend.confidence === "medium") {
    summary = `Current trend would reach ${threshold}% in ~${humanDays(fromDays)}–${humanDays(toDays)}`;
  } else {
    // low confidence: direction only, NO ETA (Fase 23).
    return {
      ...base,
      summary: `Usage rising slowly (${movePerWeek.toFixed(1)}%/week) — too early for an estimate`,
      projectedThreshold: threshold,
      confidence: "low",
    };
  }

  return {
    ...base,
    summary,
    projectedThreshold: threshold,
    projectedThresholdFrom: new Date(now + fromDays * 86_400_000).toISOString(),
    projectedThresholdTo: new Date(now + toDays * 86_400_000).toISOString(),
  };
}

function humanDays(days: number): string {
  if (days < 14) return `${Math.max(1, Math.round(days))} days`;
  if (days < 70) return `${Math.round(days / 7)} weeks`;
  return `${(days / 30.4).toFixed(1)} months`;
}

/** Converts raw filesystem bytes to a usage-percent series. */
export function usagePercentSeries(
  sizeSamples: TrendSample[],
  availSamples: TrendSample[],
): TrendSample[] {
  const availByTime = new Map(availSamples.map((sample) => [sample.t, sample]));
  return sizeSamples.map((sizeSample) => {
    const avail = availByTime.get(sizeSample.t);
    if (sizeSample.value == null || avail == null || avail.value == null || sizeSample.value <= 0) {
      return { t: sizeSample.t, value: null, quality: sizeSample.quality === "missing" || avail?.quality === "missing" ? "missing" : sizeSample.quality };
    }
    const used = sizeSample.value - avail.value;
    return {
      t: sizeSample.t,
      value: (used / sizeSample.value) * 100,
      quality: sizeSample.quality === "good" && avail.quality === "good" ? "good" : "partial",
    };
  });
}

/** Confidence label helper for non-trend consumers (Fase 14). */
export function confidenceFromSamples(sampleCount: number, coverage: number): Confidence {
  if (sampleCount < 8 || coverage < 0.5) return "insufficient";
  if (sampleCount >= 20 && coverage >= 0.95) return "high";
  if (sampleCount >= 12 && coverage >= 0.75) return "medium";
  return "low";
}
