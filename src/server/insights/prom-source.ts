import { getPromClient, isPrometheusConfigured } from "@/server/prometheus/client";
import { noteSourceAttempt } from "@/server/incidents/source-health";
import type { TrendRange } from "@/lib/api-types";
import { RANGE_MS, RANGE_STEP_SECONDS, RANGE_TTL_MS, aggregate, type SeriesStats, seriesStats } from "./timeseries";

/**
 * Prometheus history source for the insight layer (v1.6.0).
 *
 * Range queries are TTL-cached per (query, range) — a 24h trend is never
 * refetched more than once per 5 minutes, 7d per 15, 30d per hour
 * (Fase 22). No duplication of Prometheus history (Fase 21): this module
 * READS, it never stores samples.
 */

const globalStore = globalThis as unknown as {
  __insightsRangeCache?: Map<string, { at: number; points: Array<{ t: number; value: number | null }> }>;
  __insightsRangeInflight?: Map<string, Promise<Array<{ t: number; value: number | null }>>>;
};

function cacheMap(): Map<string, { at: number; points: Array<{ t: number; value: number | null }> }> {
  if (!globalStore.__insightsRangeCache) globalStore.__insightsRangeCache = new Map();
  return globalStore.__insightsRangeCache;
}

export function prometheusHistoryCapability(): { available: boolean; reason: string | null } {
  if (!isPrometheusConfigured()) {
    return { available: false, reason: "Prometheus is not configured" };
  }
  return { available: true, reason: null };
}

/** True when the TSDB can plausibly serve this range (retention honesty). */
export function rangeSupported(range: TrendRange): { ok: boolean; reason: string | null } {
  if (range === "30d") {
    // Prometheus default TSDB retention is 15d; without an explicit
    // longer retention a 30d trend would be mostly fabricated gaps.
    return { ok: false, reason: "Prometheus retention on this install is shorter than 30 days" };
  }
  return { ok: true, reason: null };
}

/** Cached range fetch: one series of (t, value) points per query/range. */
export async function fetchRange(
  query: string,
  range: TrendRange,
): Promise<Array<{ t: number; value: number | null }>> {
  if (!isPrometheusConfigured()) return [];
  const cacheKey = `${range}:${query}`;
  const cached = cacheMap().get(cacheKey);
  if (cached && Date.now() - cached.at < RANGE_TTL_MS[range]) return cached.points;

  const inflight = (globalStore.__insightsRangeInflight ??= new Map());
  const existing = inflight.get(cacheKey);
  if (existing) return existing;

  const promise = (async () => {
    const now = Date.now();
    const startSeconds = Math.floor((now - RANGE_MS[range]) / 1000);
    const endSeconds = Math.floor(now / 1000);
    const step = RANGE_STEP_SECONDS[range];
    const startedAt = Date.now();
    try {
      const client = getPromClient();
      const seriesList = await client.range(query, startSeconds, endSeconds, step);
      const points = seriesList.flatMap((series) =>
        (series.points ?? []).map((point) => ({
          t: point.t * 1000,
          value: point.v != null && Number.isFinite(point.v) ? point.v : null,
        })),
      );
      noteSourceAttempt("prometheus", { ok: true, at: Date.now(), latencyMs: Date.now() - startedAt });
      cacheMap().set(cacheKey, { at: Date.now(), points });
      return points;
    } catch (error) {
      noteSourceAttempt("prometheus", {
        ok: false,
        at: Date.now(),
        latencyMs: Date.now() - startedAt,
        safeError: error instanceof Error ? error.message.slice(0, 120) : "range query failed",
      });
      // Trending over stale source data is forbidden — return empty; the
      // caller marks quality "missing" and suppresses forecasts (Fase 29).
      return [];
    } finally {
      inflight.delete(cacheKey);
    }
  })();
  inflight.set(cacheKey, promise);
  return promise;
}

/** Fetch + aggregate into bounded buckets with quality labels. */
export async function fetchAggregated(
  query: string,
  range: TrendRange,
  options: { staleBefore?: number } = {},
): Promise<{ samples: ReturnType<typeof aggregate>; stats: SeriesStats; points: Array<{ t: number; value: number | null }> }> {
  const points = await fetchRange(query, range);
  const now = Date.now();
  const samples = aggregate(points, now, range, options);
  return { samples, stats: seriesStats(samples), points };
}

/** Test hook. */
export function resetInsightsRangeCache(): void {
  globalStore.__insightsRangeCache = undefined;
  globalStore.__insightsRangeInflight = undefined;
}
