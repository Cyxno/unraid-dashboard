import {
  CPU_PER_CORE_QUERY,
  CPU_THREADS_QUERY,
  CPU_TOTAL_QUERY,
  LOAD15_QUERY,
  LOAD1_QUERY,
  LOAD5_QUERY,
  MEMORY_AVAILABLE_QUERY,
  MEMORY_BUFFERS_QUERY,
  MEMORY_CACHED_QUERY,
  MEMORY_TOTAL_QUERY,
  MEMORY_USED_QUERY,
  SWAP_TOTAL_QUERY,
  SWAP_USED_QUERY,
  UPTIME_SECONDS_QUERY,
} from "./queries";
import { PromClient, withCache } from "./client";
import { LOAD_ELEVATED_PER_THREAD, LOAD_HIGH_PER_THREAD } from "@/server/thresholds";
import type {
  HistoryPoint,
  LoadInfo,
  LoadLevel,
  NamedSeries,
  PerCoreCpu,
} from "@/lib/api-types";

/**
 * System-level runtime metrics from Prometheus (node-exporter).
 * Instant snapshot is cached 2–3s; range queries are cached per window.
 */

function loadLevel(load5: number | null, threads: number | null): LoadLevel {
  if (load5 === null || threads === null || threads <= 0) return null;
  if (load5 > threads * LOAD_HIGH_PER_THREAD) return "high";
  if (load5 > threads * LOAD_ELEVATED_PER_THREAD) return "elevated";
  return "normal";
}

/** Instant system snapshot. Cached 2s so 3–5s browser polls stay cheap. */
export async function getSystemSnapshot(
  client: PromClient,
): Promise<{
  cpuPercent: number | null;
  perCore: PerCoreCpu[];
  load: LoadInfo;
  memory: {
    totalBytes: number | null;
    usedBytes: number | null;
    availableBytes: number | null;
    cachedBytes: number | null;
    buffersBytes: number | null;
    swapTotalBytes: number | null;
    swapUsedBytes: number | null;
  };
  uptimeSeconds: number | null;
}> {
  return withCache("system:snapshot", 2_000, async () => {
    const [
      cpuTotal,
      perCoreSamples,
      load1,
      load5,
      load15,
      threads,
      memUsed,
      memAvail,
      memTotal,
      memCached,
      memBuffers,
      swapUsed,
      swapTotal,
      uptime,
    ] = await Promise.all([
      client.instant(CPU_TOTAL_QUERY("2m")),
      client.instant(CPU_PER_CORE_QUERY("2m")),
      client.instant(LOAD1_QUERY),
      client.instant(LOAD5_QUERY),
      client.instant(LOAD15_QUERY),
      client.instant(CPU_THREADS_QUERY),
      client.instant(MEMORY_USED_QUERY),
      client.instant(MEMORY_AVAILABLE_QUERY),
      client.instant(MEMORY_TOTAL_QUERY),
      client.instant(MEMORY_CACHED_QUERY),
      client.instant(MEMORY_BUFFERS_QUERY),
      client.instant(SWAP_USED_QUERY),
      client.instant(SWAP_TOTAL_QUERY),
      client.instant(UPTIME_SECONDS_QUERY).catch(() => []),
    ]);

    const firstValue = (samples: Array<{ v: number | null }>) =>
      samples[0]?.v ?? null;

    const perCore: PerCoreCpu[] = perCoreSamples
      .map((sample) => ({
        id: sample.metric.cpu ?? "?",
        percent: sample.v,
      }))
      .sort(
        (a, b) =>
          Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10) ||
          a.id.localeCompare(b.id),
      );

    const load5Value = firstValue(load5);
    const threadCount = firstValue(threads);

    return {
      cpuPercent: firstValue(cpuTotal),
      perCore,
      load: {
        one: firstValue(load1),
        five: load5Value,
        fifteen: firstValue(load15),
        threads: threadCount,
        level: loadLevel(load5Value, threadCount),
      },
      memory: {
        totalBytes: firstValue(memTotal),
        usedBytes: firstValue(memUsed),
        availableBytes: firstValue(memAvail),
        cachedBytes: firstValue(memCached),
        buffersBytes: firstValue(memBuffers),
        swapTotalBytes: firstValue(swapTotal),
        swapUsedBytes: firstValue(swapUsed),
      },
      uptimeSeconds: firstValue(uptime),
    };
  });
}

export interface SystemHistoryResult {
  series: NamedSeries[];
  breakdown: NamedSeries[];
  summary?: { min: number | null; max: number | null; avg: number | null };
}

export interface HistoryQuery {
  name: string;
  query: string;
  /**
   * "sum" (default): point-wise sum across result series (aggregates
   * like total network RX across interfaces). "expand": one named
   * series per result entry, named by its label (per-core CPU).
   */
  mode?: "sum" | "expand";
  /** Label key used to name expanded series ("cpu" -> cpu0, cpu1…). */
  labelFrom?: string;
  /** Prefix for expanded series names. */
  labelPrefix?: string;
}

/**
 * Range history for one system metric family. Aggregates are summed
 * point-wise (never concatenated); labeled queries expand into one
 * series per Prometheus result entry.
 */
export async function getSystemHistory(
  client: PromClient,
  queries: {
    primary: HistoryQuery[];
    breakdown?: HistoryQuery[];
  },
  startSeconds: number,
  endSeconds: number,
  stepSeconds: number,
): Promise<SystemHistoryResult> {
  const toSeries = async (entry: HistoryQuery): Promise<NamedSeries[]> => {
    const matrix = await client.range(
      entry.query,
      startSeconds,
      endSeconds,
      stepSeconds,
    );
    if (entry.mode === "expand") {
      return matrix
        .map((series) => ({
          name: `${entry.labelPrefix ?? ""}${series.metric[entry.labelFrom ?? ""] ?? entry.name}`,
          points: series.points.map((point) => ({
            t: point.t * 1000,
            v: point.v,
          })),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    // Point-wise sum across result series; timestamps with no samples
    // stay null so charts break the line instead of faking zeros.
    const perTime = new Map<number, number | null>();
    for (const series of matrix) {
      for (const point of series.points) {
        if (!perTime.has(point.t)) perTime.set(point.t, null);
        if (point.v !== null) {
          perTime.set(point.t, (perTime.get(point.t) ?? 0) + point.v);
        }
      }
    }
    const points: HistoryPoint[] = [...perTime.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => ({ t: t * 1000, v }));
    return [{ name: entry.name, points }];
  };

  const primarySeries = await Promise.all(queries.primary.map(toSeries));
  const breakdownSeries = queries.breakdown
    ? await Promise.all(queries.breakdown.map(toSeries))
    : [];

  const series = primarySeries.flat();
  const breakdown = breakdownSeries.flat();

  const result: SystemHistoryResult = { series, breakdown };
  if (series[0]) {
    const values = series[0].points
      .map((point) => point.v)
      .filter((value): value is number => value !== null);
    if (values.length > 0) {
      result.summary = {
        min: Math.min(...values),
        max: Math.max(...values),
        avg: values.reduce((sum, value) => sum + value, 0) / values.length,
      };
    }
  }
  return result;
}

/** Per-core CPU series over a range (breakdown-only query). */
export async function getPerCoreHistory(
  client: PromClient,
  query: string,
  startSeconds: number,
  endSeconds: number,
  stepSeconds: number,
): Promise<NamedSeries[]> {
  const matrix = await client.range(query, startSeconds, endSeconds, stepSeconds);
  return matrix
    .map((entry) => ({
      name: `cpu${entry.metric.cpu ?? "?"}`,
      labels: { cpu: entry.metric.cpu ?? "" },
      points: entry.points.map((point) => ({
        t: point.t * 1000,
        v: point.v,
      })),
    }))
    .sort(
      (a, b) =>
        Number.parseInt(a.name.slice(3), 10) -
          Number.parseInt(b.name.slice(3), 10) ||
        a.name.localeCompare(b.name),
    );
}
