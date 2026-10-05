import {
  isPrometheusConfigured,
  PromClient,
  PrometheusError,
  withCache,
} from "./prometheus/client";
import {
  WINDOW_CACHE_TTL_MS,
  WINDOW_MS,
  WINDOW_SECONDS,
  WINDOW_STEP_SECONDS,
  type HistoryWindow,
} from "./prometheus/windows";
import {
  CPU_PER_CORE_QUERY,
  CPU_TOTAL_QUERY,
  CONTAINER_CPU_RATE_WINDOW,
  DISK_READ_IOPS_QUERY,
  DISK_READ_QUERY,
  DISK_WRITTEN_QUERY,
  DISK_WRITE_IOPS_QUERY,
  IFACE_RX_QUERY,
  IFACE_TX_QUERY,
  LOAD1_QUERY,
  LOAD15_QUERY,
  LOAD5_QUERY,
  MEMORY_USED_QUERY,
} from "./prometheus/queries";
import { fetchInventory } from "./docker/updates";
import {
  getPackagePeak,
  getThermalHistory,
  getThermalSnapshot,
  PACKAGE_SENSOR_LABEL,
} from "./prometheus/thermal";
import {
  getSystemHistory,
  getSystemSnapshot,
  type HistoryQuery,
} from "./prometheus/system";
import {
  getInterfacesHistory,
  getInterfacesInstant,
  pickPrimaryInterface,
} from "./prometheus/network";
import { getDiskIo, getStorageHistory } from "./prometheus/storage";
import {
  getContainerHistory,
  getContainerNetworkHistory,
  getTopConsumers,
} from "./prometheus/containers";
import { getBuildInfo } from "./version";
import { agentCounters as getAgentCounters, isAgentApiEnabled } from "./agent/auth";
import { getEnv, getEnvSafe } from "./env";
import { mkdir, open, rm, stat as statFile, statfs } from "node:fs/promises";
import os from "node:os";
import {
  dashboardsStorageHealth,
  DASHBOARD_SCHEMA_VERSION,
} from "./dashboards/store";
import { getHelperStatus } from "./update/helper-client";
import { checkForUpdate } from "./actions/update-check";
import {
  samplerRunning,
  subscriberCount,
} from "./events/sampler";
import { getConnectionStatus, sectionLastSuccess } from "./unraid/service";
import type {
  ContainerHistoryPayload,
  DiagnosticsPayload,
  DiskIoSnapshot,
  HistoryPoint,
  InterfaceHistoryPayload,
  LiveStatus,
  MetricMeta,
  NamedSeries,
  OverviewExtras,
  StorageHistoryPayload,
  SystemHistoryMetric,
  SystemHistoryPayload,
  SystemMetricsSnapshot,
  TopConsumers,
} from "@/lib/api-types";

/**
 * Observability service: turns Prometheus data into frontend-safe DTOs
 * with explicit provenance and graceful degradation.
 *
 * Contract (mirrors the Unraid section contract):
 * - Prometheus configured + query ok  -> status "live"
 * - query fails, last payload kept    -> status "stale" + reason
 * - query fails, nothing kept /
 *   Prometheus not configured         -> status "unavailable"
 * Data is never fabricated; absent metrics are nulls and the UI marks
 * them unavailable.
 */

const promClient = () => new PromClient();

/* Last-known-good store -------------------------------------------------- */

const globalStore = globalThis as unknown as {
  __dashboardPromLastGood?: Map<string, { at: number; value: unknown }>;
  __dashboardPromLastSuccess?: Map<string, number>;
};

function lastGoodMap(): Map<string, { at: number; value: unknown }> {
  if (!globalStore.__dashboardPromLastGood) {
    globalStore.__dashboardPromLastGood = new Map();
  }
  return globalStore.__dashboardPromLastGood;
}

function lastSuccessMap(): Map<string, number> {
  if (!globalStore.__dashboardPromLastSuccess) {
    globalStore.__dashboardPromLastSuccess = new Map();
  }
  return globalStore.__dashboardPromLastSuccess;
}

function noteSuccess(domain: string): void {
  lastSuccessMap().set(domain, Date.now());
}

/**
 * Runs a Prometheus fetch with TTL caching, last-known-good retention and
 * normalized degradation. `fn` should return the DTO payload WITHOUT the
 * meta block; this wrapper attaches it.
 */
async function withDegrade<T>(
  domain: string,
  cacheKey: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ meta: MetricMeta; data: T | null }> {
  const cacheFullKey = `lg:${cacheKey}`;
  if (!isPrometheusConfigured()) {
    return {
      meta: {
        source: "prometheus",
        status: "unavailable",
        sampledAt: new Date().toISOString(),
        reason: "Prometheus is not configured (PROMETHEUS_URL missing)",
      },
      data: null,
    };
  }
  try {
    const data = await withCache(cacheKey, ttlMs, fn);
    noteSuccess(domain);
    lastGoodMap().set(cacheFullKey, { at: Date.now(), value: data });
    return {
      meta: { source: "prometheus", status: "live", sampledAt: new Date().toISOString() },
      data,
    };
  } catch (error) {
    const reason =
      error instanceof PrometheusError
        ? `${error.kind}: ${error.message}`
        : error instanceof Error
          ? error.message
          : "unknown Prometheus error";
    const lastGood = lastGoodMap().get(cacheFullKey);
    if (lastGood) {
      return {
        meta: {
          source: "prometheus",
          status: "stale",
          sampledAt: new Date(lastGood.at).toISOString(),
          reason,
        },
        data: lastGood.value as T,
      };
    }
    return {
      meta: { source: "prometheus", status: "unavailable", sampledAt: new Date().toISOString(), reason },
      data: null,
    };
  }
}

/* System snapshot ---------------------------------------------------------- */

export type SystemSnapshotResult = {
  meta: MetricMeta;
  data: SystemMetricsSnapshot | null;
};

export async function getSystemMetrics(): Promise<SystemSnapshotResult> {
  const result = await withDegrade(
    "system",
    "system:metrics:snapshot",
    3_000,
    async () => {
      const client = promClient();
      const [snapshot, thermal] = await Promise.all([
        getSystemSnapshot(client),
        getThermalSnapshot(client),
      ]);
      const payload: SystemMetricsSnapshot = {
        meta: { source: "prometheus", status: "live", sampledAt: new Date().toISOString() },
        cpuPercent: snapshot.cpuPercent,
        perCore: snapshot.perCore,
        load: snapshot.load,
        memory: snapshot.memory,
        thermal,
        uptimeSeconds: snapshot.uptimeSeconds,
      };
      return payload;
    },
  );
  return result;
}

/* System history ------------------------------------------------------------ */

const MEMORY_PERCENT_RANGE_QUERY =
  "100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)";

function buildHistoryQueries(
  metric: SystemHistoryMetric,
  rateWindow: string,
): { primary: HistoryQuery[]; breakdown?: HistoryQuery[] } {
  switch (metric) {
    case "cpu":
      return {
        primary: [{ name: "cpu", query: CPU_TOTAL_QUERY(rateWindow) }],
        breakdown: [{ name: "per-core", query: CPU_PER_CORE_QUERY(rateWindow), mode: "expand" as const, labelFrom: "cpu", labelPrefix: "cpu" }],
      };
    case "memory":
      return {
        primary: [
          { name: "memory-percent", query: MEMORY_PERCENT_RANGE_QUERY },
          { name: "memory-used-bytes", query: MEMORY_USED_QUERY },
        ],
      };
    case "load":
      return {
        primary: [
          { name: "load1", query: LOAD1_QUERY },
          { name: "load5", query: LOAD5_QUERY },
          { name: "load15", query: LOAD15_QUERY },
        ],
      };
    case "network":
      return {
        primary: [
          { name: "rx", query: IFACE_RX_QUERY(rateWindow) },
          { name: "tx", query: IFACE_TX_QUERY(rateWindow) },
        ],
      };
    case "disk":
      return {
        primary: [
          { name: "read", query: DISK_READ_QUERY(rateWindow) },
          { name: "write", query: DISK_WRITTEN_QUERY(rateWindow) },
        ],
      };
    case "temps":
      return { primary: [] };
  }
}

export async function getSystemHistoryPayload(
  metric: SystemHistoryMetric,
  window: HistoryWindow,
): Promise<SystemHistoryPayload> {
  const rateWindow = `${Math.max(
    WINDOW_STEP_SECONDS[window] * 2,
    60,
  )}s`;
  const end = Math.floor(Date.now() / 1000);
  const start = end - WINDOW_SECONDS[window];
  const step = WINDOW_STEP_SECONDS[window];

  const result = await withDegrade(
    `history:${metric}`,
    `system-history:${metric}:${window}`,
    WINDOW_CACHE_TTL_MS[window],
    async () => {
      const client = promClient();
      if (metric === "temps") {
        return await getThermalHistory(
          client,
          "homelab_temperature_celsius",
          start,
          end,
          step,
        );
      }
      const queries = buildHistoryQueries(metric, rateWindow);
      return await getSystemHistory(client, queries, start, end, step);
    },
  );

  const series: NamedSeries[] = [];
  let breakdown: NamedSeries[] = [];
  let sensorStats: SystemHistoryPayload["sensorStats"];
  let summary: SystemHistoryPayload["summary"];

  if (metric === "temps") {
    if (result.data) {
      const thermal = result.data as Awaited<ReturnType<typeof getThermalHistory>>;
      series.push(...thermal.series);
      sensorStats = thermal.stats;
    }
  } else {
    const data = result.data as
      | { series: NamedSeries[]; breakdown?: NamedSeries[]; summary?: SystemHistoryPayload["summary"] }
      | null;
    if (data) {
      series.push(...data.series);
      breakdown = data.breakdown ?? [];
      summary = data.summary;
    }
  }

  return {
    meta: result.meta,
    window,
    stepSeconds: step,
    metric,
    series,
    breakdown,
    summary,
    sensorStats,
  };
}

/* Containers ----------------------------------------------------------------- */

export async function getContainerHistoryPayload(
  name: string,
  window: HistoryWindow,
): Promise<ContainerHistoryPayload> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - WINDOW_SECONDS[window];
  const step = WINDOW_STEP_SECONDS[window];
  const { promqlString } = await import("./prometheus/containers");
  const { containerCpuQuery, containerMemoryUsedQuery } = await import(
    "./prometheus/queries"
  );

  // Id-anchored history: resolve the container's Docker id from the helper
  // inventory so a recreated container (same name, new id) never blends
  // with its predecessor's series. Falls back to the cAdvisor name label
  // when the helper is unreachable.
  const inventory = await fetchInventory();
  const shortId = inventory?.containers.find((c) => c.name === name)?.id ?? null;

  const result = await withDegrade(
    `container-history:${name}`,
    `container-history:${name}:${window}`,
    WINDOW_CACHE_TTL_MS[window],
    async () => {
      const client = promClient();
      const [base, network] = await Promise.all([
        getContainerHistory(client, name, {
          cpu: shortId
            ? containerCpuQuery(shortId)
            : `100 * sum (rate(container_cpu_usage_seconds_total{name=${promqlString(name)}}[${CONTAINER_CPU_RATE_WINDOW}]))`,
          memory: shortId
            ? containerMemoryUsedQuery(shortId)
            : `container_memory_working_set_bytes{name=${promqlString(name)}}`,
        }, start, end, step),
        getContainerNetworkHistory(
          name,
          start,
          end,
          step,
          `${Math.max(WINDOW_STEP_SECONDS[window] * 2, 60)}s`,
        ).catch(() => null),
      ]);
      return { ...base, network };
    },
  );

  return {
    meta: result.meta,
    window,
    stepSeconds: step,
    name,
    cpu: result.data?.cpu ?? [],
    memoryBytes: result.data?.memoryBytes ?? [],
    network: result.data?.network ?? null,
  };
}

export async function getTopConsumersPayload(): Promise<
  { meta: MetricMeta; data: TopConsumers | null }
> {
  return withDegrade("top-consumers", "top-consumers", 5_000, async () => {
    const client = promClient();
    return await getTopConsumers(client, 5);
  });
}

/* Network / storage ------------------------------------------------------------- */

export async function getInterfacesHistoryPayload(
  window: HistoryWindow,
): Promise<InterfaceHistoryPayload> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - WINDOW_SECONDS[window];
  const step = WINDOW_STEP_SECONDS[window];
  const rateWindow = `${Math.max(WINDOW_STEP_SECONDS[window] * 2, 60)}s`;

  const result = await withDegrade(
    "network-history",
    `network-history:${window}`,
    WINDOW_CACHE_TTL_MS[window],
    async () => {
      const client = promClient();
      return await getInterfacesHistory(
        client,
        IFACE_RX_QUERY(rateWindow),
        IFACE_TX_QUERY(rateWindow),
        start,
        end,
        step,
      );
    },
  );

  return {
    meta: result.meta,
    window,
    stepSeconds: step,
    interfaces: result.data ?? [],
  };
}

export async function getDiskIoSnapshot(): Promise<
  { meta: MetricMeta; data: DiskIoSnapshot | null }
> {
  return withDegrade("disk-io", "disk-io:snapshot", 3_000, async () => {
    const client = promClient();
    return await getDiskIo(client);
  });
}

export async function getStorageHistoryPayload(
  window: HistoryWindow,
): Promise<StorageHistoryPayload> {
  const end = Math.floor(Date.now() / 1000);
  const start = end - WINDOW_SECONDS[window];
  const step = WINDOW_STEP_SECONDS[window];
  const rateWindow = `${Math.max(WINDOW_STEP_SECONDS[window] * 2, 60)}s`;

  const result = await withDegrade(
    "storage-history",
    `storage-history:${window}`,
    WINDOW_CACHE_TTL_MS[window],
    async () => {
      const client = promClient();
      return await getStorageHistory(
        client,
        {
          read: DISK_READ_QUERY(rateWindow),
          write: DISK_WRITTEN_QUERY(rateWindow),
          readIops: DISK_READ_IOPS_QUERY(rateWindow),
          writeIops: DISK_WRITE_IOPS_QUERY(rateWindow),
        },
        start,
        end,
        step,
      );
    },
  );

  return {
    meta: result.meta,
    window,
    stepSeconds: step,
    read: result.data?.read ?? [],
    write: result.data?.write ?? [],
    readIops: result.data?.readIops ?? [],
    writeIops: result.data?.writeIops ?? [],
    totals: result.data?.totals ?? { read: [], write: [] },
  };
}

/* Aggregates for overview -------------------------------------------------------- */

export type OverviewExtrasData = OverviewExtras;

/** Compact Prometheus bundle for the Overview page. Never throws. */
export async function getOverviewExtras(counts?: {
  unhealthyContainers: number | null;
  highMemoryContainers: number | null;
}): Promise<OverviewExtrasData> {
  const configured = isPrometheusConfigured();
  if (!configured) {
    return {
      prometheus: { configured: false, status: "unavailable" },
      load: null,
      sustainedCpuPercent: null,
      thermal: null,
      diskIo: null,
      primaryInterface: null,
      primaryRx: null,
      primaryTx: null,
      topConsumers: null,
      unhealthyContainers: counts?.unhealthyContainers ?? null,
      highMemoryContainers: counts?.highMemoryContainers ?? null,
    };
  }

  const [system, sustained, peak, thermal5m, disk, ifaces, top] = await Promise.all([
    getSystemMetrics(),
    withDegrade("sustained-cpu", "cpu:sustained-5m", 15_000, async () => {
      const client = promClient();
      const samples = await client.instant(
        '100 * avg(rate(node_cpu_seconds_total{mode!="idle"}[5m]))',
      );
      return samples[0]?.v ?? null;
    }),
    withDegrade("thermal-peak", "thermal:peak:3600", 30_000, async () => {
      const client = promClient();
      return await getPackagePeak(client, 3600);
    }),
    withDegrade("thermal-5m", "thermal:avg5m", 30_000, async () => {
      const client = promClient();
      const samples = await client.instant(
        `avg_over_time(${PACKAGE_SENSOR_LABEL}[5m])`,
      );
      return samples[0]?.v ?? null;
    }),
    getDiskIoSnapshot(),
    getInterfacesInstant(promClient()).catch(() => null),
    getTopConsumersPayload(),
  ]);

  const primary = ifaces ? pickPrimaryInterface(ifaces) : null;
  const status: LiveStatus = system.meta.status;
  return {
    prometheus: {
      configured: true,
      status,
      reason: system.meta.reason,
    },
    load: system.data?.load ?? null,
    sustainedCpuPercent: sustained.data ?? null,
    thermal: system.data
      ? {
          packageC: system.data.thermal.packageC,
          package5mAvgC: thermal5m.data ?? null,
          peak1hC: peak.data ?? null,
          hottestC: system.data.thermal.hottestC,
          hottestName: system.data.thermal.hottestName,
        }
      : null,
    diskIo: disk.data
      ? {
          readBytesPerSec: disk.data.totals.readBytesPerSec,
          writeBytesPerSec: disk.data.totals.writeBytesPerSec,
        }
      : null,
    primaryInterface: primary?.device ?? null,
    primaryRx: primary?.rxBytesPerSec ?? null,
    primaryTx: primary?.txBytesPerSec ?? null,
    topConsumers: top.data,
    unhealthyContainers: counts?.unhealthyContainers ?? null,
    highMemoryContainers: counts?.highMemoryContainers ?? null,
  };
}

/* Diagnostics ---------------------------------------------------------------------- */

interface SelfCpuSample {
  cpuUsageMs: number;
  wallMs: number;
}

const globalDiagnosticsStore = globalThis as unknown as {
  __dashboardSelfCpu?: SelfCpuSample;
};

/** Dashboard process CPU% since the previous call (null on first call). */
function selfCpuPercent(): number | null {
  const usage = process.cpuUsage();
  const cpuUsageMs = (usage.user + usage.system) / 1000;
  const now = Date.now();
  const previous = globalDiagnosticsStore.__dashboardSelfCpu;
  globalDiagnosticsStore.__dashboardSelfCpu = { cpuUsageMs, wallMs: now };
  if (!previous) return null;
  const deltaCpu = cpuUsageMs - previous.cpuUsageMs;
  const deltaWall = now - previous.wallMs;
  if (deltaWall <= 0) return null;
  // Single process, possibly multi-threaded; cap at 100% of one core pool.
  const percent = (deltaCpu / deltaWall) * 100;
  return Math.max(0, Math.min(100 * Math.max(1, os.cpus().length), Math.round(percent * 10) / 10));
}

async function probeWritable(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    const probe = `${dir}/.write-probe-${Date.now()}`;
    const handle = await open(probe, "w");
    await handle.close();
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function getDiagnostics(): Promise<DiagnosticsPayload> {
  const connection = await getConnectionStatus().catch(() => null);
  const promReachable = { reachable: false, latencyMs: null as number | null };
  let promUrl: string | null = null;
  if (isPrometheusConfigured()) {
    try {
      const client = promClient();
      promUrl = client.targetUrl;
      Object.assign(
        promReachable,
        await client.probe(),
      );
    } catch {
      // stays unreachable
    }
  }
  const sections: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(sectionLastSuccess())) {
    sections[key] = value ? new Date(value).toISOString() : null;
  }
  const promSuccess = lastSuccessMap().get("system") ?? null;

  // v0.6 self-monitoring + persistence health (never fatal to diagnostics).
  let auditFileBytes: number | null = null;
  try {
    const auditDir = getEnv().AUDIT_DIR;
    const stat = await statFile(`${auditDir}/audit.jsonl`);
    auditFileBytes = stat.size;
  } catch {
    auditFileBytes = null;
  }
  const auditWritable = await probeWritable(getEnvSafe().AUDIT_DIR).catch(() => false);
  const dashboardsHealth = await dashboardsStorageHealth();
  const mem = process.memoryUsage();

  // v0.7: free space on the app-data volume, auth mode, helper state,
  // image digest surface (no secrets).
  let dataVolumeFreeBytes: number | null = null;
  try {
    const fsStats = await statfs(getEnvSafe().AUDIT_DIR);
    dataVolumeFreeBytes = Number(fsStats.bavail) * Number(fsStats.bsize);
  } catch {
    dataVolumeFreeBytes = null;
  }
  const helperStatus = await getHelperStatus().catch(() => null);
  const agentApiEnabled = isAgentApiEnabled();
  const env = getEnvSafe();
  const release = await checkForUpdate().catch(() => null);

  const self: DiagnosticsPayload["self"] = {
    cpuPercent: selfCpuPercent(),
    memoryRssBytes: mem.rss,
    uptimeSeconds: Math.round(process.uptime()),
    sseSubscribers: subscriberCount(),
    sseSamplerRunning: samplerRunning(),
    audit: { fileBytes: auditFileBytes, writable: auditWritable },
    dashboards: {
      count: dashboardsHealth.dashboardCount,
      writable: dashboardsHealth.writable,
      invalidFiles: dashboardsHealth.invalidFiles,
    },
    dataVolumeWritable: auditWritable && dashboardsHealth.writable,
    authMode: env.AUTH_MODE,
    dashboardSchemaVersion: DASHBOARD_SCHEMA_VERSION,
    dataVolumeFreeBytes,
    helper: {
      configured: helperStatus?.configured ?? false,
      reachable: helperStatus?.reachable ?? null,
      phase: helperStatus?.phase ?? null,
      helperVersion: helperStatus?.helperVersion ?? null,
    },
    runningImageId: helperStatus?.currentImageId ?? null,
    ghcrDigest: release?.latestManifestDigest ?? null,
    agentApi: {
      enabled: agentApiEnabled,
      requests: getAgentCounters().requests,
      authFailures: getAgentCounters().authFailures,
      rateLimitHits: getAgentCounters().rateLimitHits,
      sseClients: getAgentCounters().sseClients,
      lastRequestAt: getAgentCounters().lastRequestAt,
      lastRequestEndpoint: getAgentCounters().lastRequestEndpoint,
    },
  };

  return {
    version: getBuildInfo(),
    sources: {
      unraid: {
        reachable: connection?.reachable ?? false,
        latencyMs: connection?.latencyMs ?? null,
        lastSuccessAt: connection?.lastSuccessAt ?? null,
        targetHost: connection?.targetHost ?? null,
      },
      prometheus: {
        configured: isPrometheusConfigured(),
        reachable: promReachable.reachable,
        latencyMs: promReachable.latencyMs,
        url: promUrl,
        lastSuccessAt: promSuccess ? new Date(promSuccess).toISOString() : null,
      },
    },
    sections,
    self,
    generatedAt: new Date().toISOString(),
  };
}

/** HistoryPoint count guard: strips points older than the window. */
export function trimPoints(
  points: HistoryPoint[],
  windowSeconds: number,
): HistoryPoint[] {
  const cutoff = Date.now() - windowSeconds * 1000;
  return points.filter((point) => point.t >= cutoff);
}

/* Overview history ---------------------------------------------------------- */

export interface OverviewHistoryData {
  meta: MetricMeta;
  /** CPU %, RAM %, RX and TX per timestamp (ResourceSample shape). */
  samples: Array<{
    time: number;
    cpu: number;
    memory: number;
    rx: number;
    tx: number;
  }>;
  windowFilled: boolean;
}

/**
 * Overview chart history: CPU/RAM percent + aggregate physical RX/TX as
 * one aligned series set. Points without a sample become NaN so the
 * ResourceSample contract (plain numbers) holds while charts break lines.
 */
export async function getOverviewHistory(
  window: HistoryWindow,
): Promise<OverviewHistoryData> {
  const rateWindow = `${Math.max(WINDOW_STEP_SECONDS[window] * 2, 60)}s`;
  const end = Math.floor(Date.now() / 1000);
  const start = end - WINDOW_SECONDS[window];
  const step = WINDOW_STEP_SECONDS[window];

  const result = await withDegrade(
    "overview-history",
    `overview-history:${window}`,
    WINDOW_CACHE_TTL_MS[window],
    async () => {
      const client = promClient();
      const [cpuMatrix, memMatrix, rxMatrix, txMatrix] = await Promise.all([
        client.range(CPU_TOTAL_QUERY(rateWindow), start, end, step),
        client.range(MEMORY_PERCENT_RANGE_QUERY, start, end, step),
        client.range(IFACE_RX_QUERY(rateWindow), start, end, step),
        client.range(IFACE_TX_QUERY(rateWindow), start, end, step),
      ]);
      const collapse = (
        matrix: Awaited<ReturnType<PromClient["range"]>>,
      ): Map<number, number | null> => {
        const perTime = new Map<number, number | null>();
        for (const entry of matrix) {
          for (const point of entry.points) {
            const existing = perTime.get(point.t);
            if (point.v === null) {
              perTime.set(point.t, existing ?? null);
            } else {
              perTime.set(point.t, (existing ?? 0) + point.v);
            }
          }
        }
        return perTime;
      };
      return {
        cpu: collapse(cpuMatrix),
        memory: collapse(memMatrix),
        rx: collapse(rxMatrix),
        tx: collapse(txMatrix),
      };
    },
  );

  if (!result.data) {
    return { meta: result.meta, samples: [], windowFilled: false };
  }

  const times = [
    ...new Set<number>([
      ...result.data.cpu.keys(),
      ...result.data.memory.keys(),
      ...result.data.rx.keys(),
      ...result.data.tx.keys(),
    ]),
  ].sort((a, b) => a - b);

  const samples = times.map((t) => ({
    time: t * 1000,
    cpu: result.data!.cpu.get(t) ?? Number.NaN,
    memory: result.data!.memory.get(t) ?? Number.NaN,
    rx: result.data!.rx.get(t) ?? Number.NaN,
    tx: result.data!.tx.get(t) ?? Number.NaN,
  }));

  const first = samples[0];
  const windowFilled =
    first !== undefined && first.time <= Date.now() - WINDOW_MS[window] * 0.9;

  return { meta: result.meta, samples, windowFilled };
}
