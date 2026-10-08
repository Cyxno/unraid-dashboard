import type { DataQuality, TrendRange, TrendResult, TrendSample } from "@/lib/api-types";

/**
 * Canonical timeseries layer (v1.6.0 Fase 1).
 *
 * Small, bounded aggregates over raw history — never raw sample dumps.
 * A series is a list of bucketed samples with per-bucket QUALITY:
 *   good     enough coverage inside the bucket
 *   partial  some points present, bucket sparser than its step
 *   stale    bucket covered but the underlying source was degraded
 *   missing  no points at all (a GAP — never zero-filled, Fase 20)
 *
 * No extrapolation runs over bad data: forecast/anomaly consumers are
 * required to check `quality` and `coverage` (helpers below).
 */

export const RANGE_MS: Record<TrendRange, number> = {
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
};

/** Prometheus range-query step per insight range (server-side aggregation). */
export const RANGE_STEP_SECONDS: Record<TrendRange, number> = {
  "24h": 600, // 10-min raw steps → aggregated to hourly buckets (24 points)
  "7d": 1800, // 30-min steps → 6-hourly buckets (28 points)
  "30d": 21600, // 6-hourly steps → daily buckets (30 points)
};

/**
 * Cache TTL per range (Fase 22): trends are NOT refreshed every poll.
 * A 24h trend is never useful more than once every 5 minutes.
 */
export const RANGE_TTL_MS: Record<TrendRange, number> = {
  "24h": 5 * 60_000,
  "7d": 15 * 60_000,
  "30d": 60 * 60_000,
};

/** Bucket length per range: the "hourly/daily" aggregates (Fase 1). */
export const RANGE_BUCKET_MS: Record<TrendRange, number> = {
  "24h": 60 * 60_000, // hourly
  "7d": 6 * 60 * 60_000, // 6-hourly
  "30d": 24 * 60 * 60_000, // daily
};

/**
 * Aggregates raw (timestamp,value) points into bounded buckets. A bucket
 * holds the MEAN of its points; coverage = points/expected. Buckets with
 * zero points are explicit gaps (value null, quality "missing").
 */
export function aggregate(
  points: Array<{ t: number; value: number | null }>,
  now: number,
  range: TrendRange,
  options: { staleBefore?: number } = {},
): TrendSample[] {
  const bucketMs = RANGE_BUCKET_MS[range];
  const start = now - RANGE_MS[range];
  // ABSOLUTE grid alignment: buckets are anchored to epoch multiples, not
  // to the fetch moment — two separately cached fetches (size + avail)
  // must produce IDENTICAL bucket timestamps for the join (v1.6.0 bug
  // found live: relative anchors made every paired lookup null).
  const firstBucket = Math.ceil(start / bucketMs) * bucketMs;
  const lastBucket = Math.floor(now / bucketMs) * bucketMs;
  const buckets = new Map<number, { sum: number; n: number }>();
  for (const point of points) {
    if (point.t < start - bucketMs || point.value == null || !Number.isFinite(point.value)) continue;
    const bucket = Math.floor(point.t / bucketMs) * bucketMs;
    const entry = buckets.get(bucket) ?? { sum: 0, n: 0 };
    entry.sum += point.value;
    entry.n += 1;
    buckets.set(bucket, entry);
  }
  const expectedPerBucket = Math.max(1, Math.round(bucketMs / estimateRawStep(points)));
  const staleBefore = options.staleBefore ?? 0;
  const samples: TrendSample[] = [];
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += bucketMs) {
    const entry = buckets.get(bucket);
    if (!entry) {
      samples.push({ t: new Date(bucket).toISOString(), value: null, quality: "missing" });
      continue;
    }
    const coverage = entry.n / expectedPerBucket;
    const quality: DataQuality =
      coverage >= 0.75 ? "good" : coverage >= 0.25 ? "partial" : staleBefore > 0 && bucket < staleBefore ? "stale" : "partial";
    samples.push({ t: new Date(bucket).toISOString(), value: entry.sum / entry.n, quality });
  }
  return samples;
}

/** Estimates the raw step from point spacing (fallback 5 min). */
function estimateRawStep(points: Array<{ t: number }>): number {
  if (points.length < 2) return 300_000;
  const deltas: number[] = [];
  for (let i = 1; i < Math.min(points.length, 50); i++) {
    const d = points[i]!.t - points[i - 1]!.t;
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return 300_000;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)]!;
}

export interface SeriesStats {
  values: number[];
  coverage: number;
  gaps: number;
  longestGapBuckets: number;
  quality: DataQuality;
}

/** Statistics over the GOOD/PARTIAL portion of a series (Fase 20). */
export function seriesStats(samples: TrendSample[]): SeriesStats {
  const values = samples.filter((s) => s.value != null).map((s) => s.value as number);
  const missing = samples.filter((s) => s.quality === "missing").length;
  let longestGapBuckets = 0;
  let run = 0;
  for (const sample of samples) {
    if (sample.quality === "missing") {
      run += 1;
      longestGapBuckets = Math.max(longestGapBuckets, run);
    } else {
      run = 0;
    }
  }
  const coverage = samples.length > 0 ? (samples.length - missing) / samples.length : 0;
  const goodish = samples.filter((s) => s.quality === "good" || s.quality === "partial").length;
  const staleCount = samples.filter((s) => s.quality === "stale").length;
  const quality: DataQuality =
    samples.length === 0 || values.length === 0
      ? "missing"
      : staleCount / samples.length >= 0.3
        ? "stale" // the underlying source was degraded for much of the window
        : coverage >= 0.9 && goodish / Math.max(1, samples.length) >= 0.9
          ? "good"
          : coverage >= 0.5
            ? "partial"
            : "stale";
  return { values, coverage, gaps: missing, longestGapBuckets, quality };
}

/**
 * Deterministic linear trend (least squares) over bucketed values, with
 * strict confidence gating (Fase 2/14): flat/noisy data never yields a
 * directional claim, sparse data never yields "high".
 */
export function linearTrend(samples: TrendSample[], range: TrendRange): TrendResult {
  const points = samples
    .map((sample) => ({ x: Date.parse(sample.t), y: sample.value }))
    .filter((p): p is { x: number; y: number } => p.y != null);
  const stats = seriesStats(samples);
  const unknown: TrendResult = {
    direction: "unknown",
    slopePerDay: null,
    fit: null,
    sampleCount: points.length,
    coverage: stats.coverage,
    quality: stats.quality,
    confidence: "insufficient",
  };
  if (points.length < MIN_TREND_POINTS) return unknown;
  if (stats.longestGapBuckets >= MAX_GAP_BUCKETS[range]) return unknown; // gap > threshold → break series

  const x0 = points[0]!.x;
  const n = points.length;
  const meanX = points.reduce((acc, p) => acc + (p.x - x0), 0) / n;
  const meanY = points.reduce((acc, p) => acc + p.y, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - x0 - meanX;
    const dy = p.y - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return unknown;
  const slopePerMs = sxy / sxx;
  const slopePerDay = slopePerMs * 86_400_000;
  const fit = syy === 0 ? 1 : Math.max(0, Math.min(1, (sxy * sxy) / (sxx * syy)));

  // Direction requires the fit to explain a real share of the variance,
  // the total move over the window to exceed a small band RELATIVE to
  // the span, and an absolute floor relative to the level (a perfectly
  // fitted jitter line on a near-constant series must stay "flat").
  const totalMove = slopePerDay * (RANGE_MS[range] / 86_400_000);
  const span = Math.max(...points.map((p) => p.y)) - Math.min(...points.map((p) => p.y));
  const moveRatio = span > 0 ? Math.abs(totalMove) / span : 0;
  const meanAbs = Math.abs(meanY);
  const absoluteMoveFloor = Math.max(meanAbs * 0.005, 1e-9);
  let direction: TrendResult["direction"] = "flat";
  if (fit >= 0.5 && moveRatio >= 0.3 && Math.abs(totalMove) >= absoluteMoveFloor && Math.abs(slopePerDay) > 1e-9) {
    direction = slopePerDay > 0 ? "rising" : "falling";
  }

  let confidence: TrendResult["confidence"] = "low";
  if (direction !== "flat" && fit >= 0.8 && stats.coverage >= 0.95 && points.length >= 20) {
    confidence = "high";
  } else if (direction !== "flat" && fit >= 0.6 && stats.coverage >= 0.75) {
    confidence = "medium";
  } else if (direction === "flat") {
    confidence = stats.coverage >= 0.75 ? "high" : stats.coverage >= 0.5 ? "medium" : "low";
  }

  return { direction, slopePerDay, fit, sampleCount: points.length, coverage: stats.coverage, quality: stats.quality, confidence };
}

/** Minimum good points for any directional claim (per-range guard). */
export const MIN_TREND_POINTS = 8;
/** A gap of this many consecutive buckets breaks the series (Fase 20). */
export const MAX_GAP_BUCKETS: Record<TrendRange, number> = {
  "24h": 4,
  "7d": 6,
  "30d": 10,
};

/** Percentile of an unsorted numeric array (nearest-rank). */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}
