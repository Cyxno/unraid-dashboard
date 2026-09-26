import {
  SERIES_ALIGN_TOLERANCE_S,
  TEMP_BUCKET_BOUNDS,
  THERMAL_EPISODE_END_C,
  THERMAL_EPISODE_END_HOLD_S,
  THERMAL_EPISODE_MIN_DURATION_S,
  THERMAL_EPISODE_START_C,
} from "@/server/thresholds";
import type { HistoryPoint } from "@/lib/api-types";

/**
 * Thermal diagnostics v2 — pure analysis functions over Prometheus range
 * data. Everything here is deterministic and unit-tested; the network
 * fetches live in thermal.ts/metrics-service.ts and only feed these.
 *
 * Honesty rules (enforced by the shapes below):
 * - Buckets count real samples; the coverage ratio exposes how much of
 *   the requested window actually had data (never pretend a full 24h).
 * - Episodes require sustained duration; single-sample spikes never
 *   become episodes.
 * - Correlation is Pearson's r on aligned samples with NO causal claim —
 *   the UI wording stays associative.
 */

export interface TempSeriesPoint {
  /** Epoch seconds (Prometheus convention inside this module). */
  t: number;
  v: number | null;
}

/* ---- duration buckets ----------------------------------------------------- */

export interface TempBuckets {
  /** Labels matching TEMP_BUCKET_BOUNDS: "<70", "70–79", "80–89", "90–94", "≥95". */
  labels: string[];
  /** Sample counts per bucket. */
  counts: number[];
  /** Fraction of requested window covered by actual samples (0–1). */
  coverageRatio: number | null;
  /** Total samples observed. */
  sampleCount: number;
  /** Implied seconds per sample (window span / samples), when computable. */
  approximateStepSeconds: number | null;
}

/** Counts temperature samples into the fixed duration buckets. */
export function bucketizeTemps(values: Array<number | null>): number[] {
  const counts = new Array<number>(TEMP_BUCKET_BOUNDS.length + 1).fill(0);
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) continue;
    let index = 0;
    while (index < TEMP_BUCKET_BOUNDS.length && value >= (TEMP_BUCKET_BOUNDS[index] as number)) {
      index += 1;
    }
    counts[index] = (counts[index] ?? 0) + 1;
  }
  return counts;
}

export const TEMP_BUCKET_LABELS = [
  `<${TEMP_BUCKET_BOUNDS[0]}°C`,
  `${TEMP_BUCKET_BOUNDS[0]}–${TEMP_BUCKET_BOUNDS[1]! - 1}°C`,
  `${TEMP_BUCKET_BOUNDS[1]}–${TEMP_BUCKET_BOUNDS[2]! - 1}°C`,
  `${TEMP_BUCKET_BOUNDS[2]}–${TEMP_BUCKET_BOUNDS[3]! - 1}°C`,
  `≥${TEMP_BUCKET_BOUNDS[3]}°C`,
] as const;

export function buildBuckets(
  points: TempSeriesPoint[],
  windowSeconds: number,
): TempBuckets {
  const numeric = points.map((point) => point.v);
  const counts = bucketizeTemps(numeric);
  const sampleCount = counts.reduce((sum, count) => sum + count, 0);
  const times = points.map((point) => point.t).sort((a, b) => a - b);
  const spanSeconds =
    times.length >= 2 ? times[times.length - 1]! - times[0]! : windowSeconds;
  const approximateStepSeconds =
    sampleCount >= 2 ? spanSeconds / (sampleCount - 1) : null;
  // Coverage: how many step-slots of the window had data.
  const expectedSlots = approximateStepSeconds
    ? Math.floor(windowSeconds / approximateStepSeconds) + 1
    : 0;
  const coverageRatio =
    expectedSlots > 0 ? Math.min(1, sampleCount / expectedSlots) : null;
  return {
    labels: [...TEMP_BUCKET_LABELS],
    counts,
    coverageRatio,
    sampleCount,
    approximateStepSeconds,
  };
}

/* ---- episode detection ----------------------------------------------------- */

export interface ThermalEpisode {
  /** Epoch ms of the first sustained sample at/above the start threshold. */
  startMs: number;
  /** Epoch ms of the last sample at/above the end threshold. */
  endMs: number | null; // null = still ongoing at the end of the window
  durationSeconds: number;
  maxC: number;
  avgC: number;
  sampleCount: number;
  /** Aligned CPU% over the episode window (null when CPU data missing). */
  avgCpuPercent: number | null;
  peakCpuPercent: number | null;
  /** Aligned package power (W) over the episode window. */
  avgPowerWatts: number | null;
  peakPowerWatts: number | null;
}

export interface EpisodeOptions {
  startC?: number;
  minDurationSeconds?: number;
  endC?: number;
  endHoldSeconds?: number;
}

/**
 * Detects sustained thermal episodes with hysteresis.
 *
 * - A candidate episode begins at the first sample >= startC.
 * - It becomes real only after minDurationSeconds of remaining at/above
 *   startC (samples with null values pause, not cancel, the candidate —
 *   a scrape gap must not split one episode into two).
 * - While active, time below endC accumulates; if it exceeds
 *   endHoldSeconds the episode closes at the last sample >= endC.
 *   Re-crossing startC within the hold window continues the SAME episode.
 * - A candidate that never reaches minDuration is discarded (spike).
 */
export function detectThermalEpisodes(
  points: TempSeriesPoint[],
  options: EpisodeOptions = {},
): ThermalEpisode[] {
  const startC = options.startC ?? THERMAL_EPISODE_START_C;
  const minDuration = options.minDurationSeconds ?? THERMAL_EPISODE_MIN_DURATION_S;
  const endC = options.endC ?? THERMAL_EPISODE_END_C;
  const endHold = options.endHoldSeconds ?? THERMAL_EPISODE_END_HOLD_S;

  const episodes: ThermalEpisode[] = [];
  type Candidate = {
    startT: number;
    lastAboveEndT: number;
    values: number[];
    confirmed: boolean;
  } | null;
  let candidate: Candidate = null;
  let belowSinceT: number | null = null;

  const close = (entry: NonNullable<Candidate>, endT: number) => {
    if (!entry.confirmed) return; // never promoted → spike, drop
    const maxC = Math.max(...entry.values);
    const avgC = entry.values.reduce((sum, value) => sum + value, 0) / entry.values.length;
    episodes.push({
      startMs: entry.startT * 1000,
      endMs: endT * 1000,
      durationSeconds: Math.max(0, Math.round(endT - entry.startT)),
      maxC: round1(maxC),
      avgC: round1(avgC),
      sampleCount: entry.values.length,
      avgCpuPercent: null,
      peakCpuPercent: null,
      avgPowerWatts: null,
      peakPowerWatts: null,
    });
  };

  for (const point of points) {
    const { t } = point;
    const v = point.v !== null && Number.isFinite(point.v) ? point.v : null;

    if (v === null) {
      // Data gap: pause (do not advance hold logic). Long gaps are
      // handled by coverage reporting, not by episode splitting.
      continue;
    }

    if (!candidate) {
      if (v >= startC) {
        candidate = { startT: t, lastAboveEndT: t, values: [v], confirmed: false };
        belowSinceT = null;
      }
      continue;
    }

    if (v >= endC) {
      candidate.lastAboveEndT = t;
      candidate.values.push(v);
      if (v >= startC) {
        belowSinceT = null;
        if (!candidate.confirmed && t - candidate.startT >= minDuration) {
          candidate.confirmed = true;
        }
      } else {
        // In the hysteresis band [endC, startC): counts toward the
        // episode but not toward its start confirmation.
        if (!candidate.confirmed && t - candidate.startT >= minDuration) {
          candidate.confirmed = true;
        }
      }
      continue;
    }

    // Below endC: potential close.
    if (belowSinceT === null) belowSinceT = t;
    if (t - belowSinceT >= endHold) {
      close(candidate, candidate.lastAboveEndT);
      candidate = null;
      belowSinceT = null;
    }
  }

  // Window ended with an open candidate: confirm/close what we have.
  if (candidate) {
    const lastT = points.length > 0 ? points[points.length - 1]!.t : candidate.lastAboveEndT;
    if (!candidate.confirmed && candidate.lastAboveEndT - candidate.startT >= minDuration) {
      candidate.confirmed = true;
    }
    if (candidate.confirmed) {
      close(candidate, candidate.lastAboveEndT);
      // Mark ongoing: endMs null when the window ended above endC.
      const last = episodes[episodes.length - 1];
      if (last && last.endMs !== null) {
        const lastPoint = [...points].reverse().find((point) => point.v !== null);
        if (lastPoint && lastPoint.v !== null && lastPoint.v >= endC) {
          last.endMs = null;
        }
      }
    }
  }

  return episodes;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/* ---- alignment + correlation ----------------------------------------------- */

/**
 * Aligns two series on nearest timestamps within tolerance. Returns
 * pairs of numeric values (nulls skipped).
 */
export function alignSeries(
  a: TempSeriesPoint[],
  b: TempSeriesPoint[],
  toleranceSeconds = SERIES_ALIGN_TOLERANCE_S,
): Array<{ t: number; av: number; bv: number }> {
  const pairs: Array<{ t: number; av: number; bv: number }> = [];
  let indexB = 0;
  for (const pointA of a) {
    if (pointA.v === null || !Number.isFinite(pointA.v)) continue;
    // Advance b to the closest timestamp.
    while (
      indexB < b.length - 1 &&
      Math.abs(b[indexB]!.t - pointA.t) > Math.abs(b[indexB + 1]!.t - pointA.t)
    ) {
      indexB += 1;
    }
    const pointB = b[indexB];
    if (
      pointB &&
      pointB.v !== null &&
      Number.isFinite(pointB.v) &&
      Math.abs(pointB.t - pointA.t) <= toleranceSeconds
    ) {
      pairs.push({ t: pointA.t, av: pointA.v, bv: pointB.v });
    }
  }
  return pairs;
}

/** Pearson r over aligned pairs. Null when fewer than 3 pairs or zero variance. */
export function pearsonCorrelation(pairs: Array<{ av: number; bv: number }>): number | null {
  if (pairs.length < 3) return null;
  const n = pairs.length;
  let sumA = 0;
  let sumB = 0;
  for (const pair of pairs) {
    sumA += pair.av;
    sumB += pair.bv;
  }
  const meanA = sumA / n;
  const meanB = sumB / n;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (const pair of pairs) {
    const da = pair.av - meanA;
    const db = pair.bv - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  if (varianceA === 0 || varianceB === 0) return null;
  return covariance / Math.sqrt(varianceA * varianceB);
}

/** Correlation strength label (associative wording only). */
export function describeCorrelation(r: number | null): string {
  if (r === null) return "not computable";
  const magnitude = Math.abs(r);
  const direction = r > 0 ? "positive" : "negative";
  if (magnitude >= 0.8) return `strong ${direction}`;
  if (magnitude >= 0.5) return `moderate ${direction}`;
  if (magnitude >= 0.3) return `weak ${direction}`;
  return "negligible";
}

/* ---- timeline --------------------------------------------------------------- */

export interface ThermalTimelineHour {
  /** Hour bucket start (epoch ms). */
  hourMs: number;
  maxC: number | null;
  avgC: number | null;
}

/** Hourly max/avg for the 24h timeline (24 buckets, sparse-safe). */
export function buildHourlyTimeline(points: TempSeriesPoint[]): ThermalTimelineHour[] {
  const buckets = new Map<number, { max: number; sum: number; count: number }>();
  for (const point of points) {
    if (point.v === null || !Number.isFinite(point.v)) continue;
    const hour = Math.floor(point.t / 3600) * 3600;
    const bucket = buckets.get(hour);
    if (bucket) {
      bucket.max = Math.max(bucket.max, point.v);
      bucket.sum += point.v;
      bucket.count += 1;
    } else {
      buckets.set(hour, { max: point.v, sum: point.v, count: 1 });
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hour, bucket]) => ({
      hourMs: hour * 1000,
      maxC: round1(bucket.max),
      avgC: round1(bucket.sum / bucket.count),
    }));
}

/** Episode stats enrichment payload shape used by the fetch layer. */
export interface CorrelatedPoint extends HistoryPoint {
  cpu: number | null;
}
