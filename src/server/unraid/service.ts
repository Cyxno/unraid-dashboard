/* eslint-disable @typescript-eslint/no-explicit-any -- raw GraphQL payloads at
   the boundary; all access goes through defensive mappers. */
import { getUnraidClient, UnraidClient } from "./client";
import {
  ARRAY_QUERY,
  CONNECTION_PING_QUERY,
  DOCKER_QUERY,
  IDENTITY_QUERY,
  LOG_FILES_QUERY,
  LOG_FILE_QUERY,
  METRICS_QUERY,
  NETWORK_INTERFACES_QUERY,
  NOTIFICATIONS_LIST_QUERY,
  NOTIFICATIONS_SUMMARY_QUERY,
  SYSTEM_QUERY,
  VMS_QUERY,
} from "./queries";
import {
  mapCpu,
  mapDocker,
  mapIdentity,
  mapLogFiles,
  mapMemoryDetail,
  mapNetworkInterfaces,
  mapNetworkThroughput,
  mapNotification,
  mapNotifications,
  mapStorage,
  mapSystemInfo,
  mapTemperature,
  mapVms,
  splitLogLines,
} from "./mappers";
import { mockOverview } from "./mock";
import { SectionProvider } from "./section";
import { deriveHealth } from "@/server/health";
import { getMetricsHistory } from "@/server/history";
import type {
  ConnectionStatus,
  DashboardNotification,
  DockerSummary,
  HistoryWindow,
  NetworkInterfaceInfo,
  NetworkThroughput,
  NotificationsSummary,
  OverviewPayload,
  ResourceSample,
  Section,
  StorageUsage,
  SystemIdentity,
  SystemInfo,
  TemperatureInfo,
  VmsSummary,
  LogFileEntry,
  LogContent,
} from "@/lib/api-types";

/**
 * Domain service layer. One SectionProvider per domain enforces the
 * live/stale/unavailable/demo contract and a server-side TTL cache, so
 * browser polls at any cadence translate into at most one Unraid query
 * per TTL per domain.
 */

const demo = mockOverview();

/* Internally-fetched raw payloads -------------------------------------- */

interface RawMetrics {
  cpuPercent: number;
  memoryPercent: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  throughput: NetworkThroughput;
  temperature: TemperatureInfo;
  interfaces: any;
  infoCpu: any;
}

const metricsProvider = new SectionProvider<RawMetrics>(
  "metrics",
  async () => {
    const client = getUnraidClient();
    const payload = await client.request(METRICS_QUERY);
    return {
      cpuPercent: (payload as any)?.metrics?.cpu?.percentTotal ?? 0,
      memoryPercent: (payload as any)?.metrics?.memory?.percentTotal ?? 0,
      memoryUsedBytes: Number((payload as any)?.metrics?.memory?.used ?? 0),
      memoryTotalBytes: Number((payload as any)?.metrics?.memory?.total ?? 0),
      throughput: mapNetworkThroughput(payload),
      temperature: mapTemperature(payload),
      interfaces: (payload as any)?.metrics?.network,
      infoCpu: (payload as any)?.info?.cpu,
    };
  },
  3_000,
);

/* Samples history on every fresh metrics fetch. */
async function getMetricsSection() {
  const section = await metricsProvider.get();
  if (section.status === "live" && section.data) {
    getMetricsHistory().record({
      cpu: section.data.cpuPercent,
      memory: section.data.memoryPercent,
      rx: section.data.throughput.rxBytesPerSec,
      tx: section.data.throughput.txBytesPerSec,
    });
  }
  return section;
}

const identityProvider = new SectionProvider<SystemIdentity>(
  "identity",
  async () => mapIdentity(await getUnraidClient().request(IDENTITY_QUERY)),
  60_000,
);

const storageProvider = new SectionProvider<StorageUsage>(
  "storage",
  async () => mapStorage(await getUnraidClient().request(ARRAY_QUERY)),
  20_000,
);

const dockerProvider = new SectionProvider<DockerSummary>(
  "docker",
  async () => mapDocker(await getUnraidClient().request(DOCKER_QUERY)),
  10_000,
);

const notificationsProvider = new SectionProvider<NotificationsSummary>(
  "notifications",
  async () =>
    mapNotifications(
      await getUnraidClient().request(NOTIFICATIONS_SUMMARY_QUERY),
    ),
  20_000,
);

const vmsProvider = new SectionProvider<VmsSummary>(
  "vms",
  async () => mapVms(await getUnraidClient().request(VMS_QUERY)),
  30_000,
);

const systemProvider = new SectionProvider<SystemInfo>(
  "system",
  async () => {
    const client = getUnraidClient();
    const [infoPayload, metricsSection] = await Promise.all([
      client.request(SYSTEM_QUERY),
      getMetricsSection(),
    ]);
    const info = mapSystemInfo(infoPayload);
    const detail = mapMemoryDetail(infoPayload);
    const metrics = metricsSection.data;
    return {
      ...info,
      memoryTotalBytes: detail.totalBytes ?? metrics?.memoryTotalBytes ?? null,
      memoryUsedBytes: metrics?.memoryUsedBytes ?? null,
      memoryAvailableBytes:
        metrics && metrics.memoryTotalBytes > 0
          ? Math.max(0, metrics.memoryTotalBytes - metrics.memoryUsedBytes)
          : null,
      temperature: metrics?.temperature ?? null,
    };
  },
  30_000,
);

/* Demo substitution ----------------------------------------------------- */

function withDemo<T>(section: Section<T>, demoData: T): Section<T> {
  if (section.status === "unavailable") {
    return {
      status: "demo",
      data: demoData,
      fetchedAt: section.fetchedAt,
      ageMs: 0,
      reason: section.reason,
    };
  }
  return section;
}

/* Public API ------------------------------------------------------------ */

export async function getOverview(
  historyWindow: HistoryWindow = "15m",
): Promise<OverviewPayload> {
  const [identity, metrics, storage, docker, notifications] = await Promise.all([
    identityProvider.get(),
    getMetricsSection(),
    storageProvider.get(),
    dockerProvider.get(),
    notificationsProvider.get(),
  ]);

  const memory: Section<{ percentTotal: number; usedBytes: number; totalBytes: number }> =
    metrics.data
      ? {
          status: metrics.status,
          data: {
            percentTotal: metrics.data.memoryPercent,
            usedBytes: metrics.data.memoryUsedBytes,
            totalBytes: metrics.data.memoryTotalBytes,
          },
          fetchedAt: metrics.fetchedAt,
          ageMs: metrics.ageMs,
          reason: metrics.reason,
        }
      : {
          status: metrics.status,
          data: null,
          fetchedAt: metrics.fetchedAt,
          ageMs: metrics.ageMs,
          reason: metrics.reason,
        };

  const cpuSection = {
    ...metrics,
    data: metrics.data
      ? mapCpu({ metrics: {}, info: { cpu: metrics.data.infoCpu } }, metrics.data.temperature)
      : null,
  };
  if (cpuSection.data) {
    cpuSection.data.percentTotal = metrics.data!.cpuPercent;
  }

  const temperatureSection: Section<TemperatureInfo> = {
    ...metrics,
    data: metrics.data ? metrics.data.temperature : null,
  };

  const networkSection: Section<NetworkThroughput> = {
    ...metrics,
    data: metrics.data ? metrics.data.throughput : null,
  };

  const history = getMetricsHistory();
  const samples: ResourceSample[] = history.slice(historyWindow);

  const payload: OverviewPayload = {
    identity: withDemo(identity, demo.identity),
    cpu: withDemo(cpuSection, demo.cpu),
    memory: withDemo(memory, demo.memory),
    temperature: withDemo(temperatureSection, {
      cpuC: null,
      boardC: null,
      hottestC: null,
      warningCount: 0,
      criticalCount: 0,
    }),
    storage: withDemo(storage, demo.storage),
    network: withDemo(networkSection, demo.network),
    docker: withDemo(docker, demo.docker),
    notifications: withDemo(notifications, demo.notifications),
    health: deriveHealth({
      storage,
      docker,
      notifications,
      memoryPercent: metrics.data?.memoryPercent ?? null,
      temperatureCriticalCount: metrics.data?.temperature.criticalCount ?? null,
    }),
    history: {
      window: historyWindow,
      totalSamples: history.totalSamples,
      windowFilled: history.windowFilled(historyWindow),
      samples,
    },
    generatedAt: new Date().toISOString(),
  };
  return payload;
}

export async function getDocker(): Promise<Section<DockerSummary>> {
  return withDemo(await dockerProvider.get(), demo.docker);
}

export async function getStorage(): Promise<Section<StorageUsage>> {
  return withDemo(await storageProvider.get(), demo.storage);
}

export async function getNetwork(): Promise<Section<NetworkInterfaceInfo[]>> {
  const [interfaces, metrics] = await Promise.all([
    new SectionProvider<any>(
      "network-interfaces",
      async () =>
        await getUnraidClient().request(NETWORK_INTERFACES_QUERY),
      10_000,
    ).get(),
    getMetricsSection(),
  ]);
  if (!interfaces.data) {
    return interfaces;
  }
  const mapped = mapNetworkInterfaces(interfaces.data, metrics.data?.interfaces);
  return { ...interfaces, data: mapped };
}

export async function getSystem(): Promise<Section<SystemInfo>> {
  return withDemo(await systemProvider.get(), {
    hostname: demo.identity.serverName,
    distro: "Unraid OS",
    kernel: null,
    arch: null,
    uefi: null,
    cpuBrand: demo.cpu.brand,
    cpuCores: demo.cpu.cores,
    cpuThreads: null,
    cpuSpeedGhz: null,
    memoryTotalBytes: demo.memory.totalBytes,
    memoryUsedBytes: demo.memory.usedBytes,
    memoryAvailableBytes: null,
    boardManufacturer: null,
    boardModel: null,
    systemManufacturer: null,
    systemModel: null,
    virtualized: null,
    temperature: null,
  });
}

export async function getVms(): Promise<Section<VmsSummary>> {
  return vmsProvider.get();
}

export type NotificationFilterInput = {
  type: "UNREAD" | "ARCHIVE";
  importance?: "INFO" | "WARNING" | "ALERT";
  limit?: number;
  offset?: number;
};

export async function getNotificationList(
  filter: NotificationFilterInput,
): Promise<Section<DashboardNotification[]>> {
  const variables: Record<string, unknown> = {
    filter: {
      type: filter.type,
      offset: filter.offset ?? 0,
      limit: Math.min(200, Math.max(1, filter.limit ?? 50)),
      ...(filter.importance ? { importance: filter.importance } : {}),
    },
  };
  try {
    const payload = await getUnraidClient().request(
      NOTIFICATIONS_LIST_QUERY,
      variables,
    );
    const list: any[] = Array.isArray((payload as any)?.notifications?.list)
      ? (payload as any).notifications.list
      : [];
    return {
      status: "live",
      data: list.map((entry, index) => mapNotification(entry, index)),
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
    };
  } catch (error) {
    return {
      status: "unavailable",
      data: null,
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
      reason: error instanceof Error ? error.message : "unknown error",
    };
  }
}

export async function getLogFiles(): Promise<Section<LogFileEntry[]>> {
  try {
    const payload = await getUnraidClient().request(LOG_FILES_QUERY);
    return {
      status: "live",
      data: mapLogFiles(payload),
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
    };
  } catch (error) {
    return {
      status: "unavailable",
      data: null,
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
      reason: error instanceof Error ? error.message : "unknown error",
    };
  }
}

/** Reads a log file, allowing only paths reported by logFiles (no traversal). */
export async function getLogFileContent(
  path: string,
  lines: number,
): Promise<Section<LogContent>> {
  const allowed = await getLogFiles();
  const known = allowed.data?.some((file) => file.path === path);
  if (!known) {
    return {
      status: "unavailable",
      data: null,
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
      reason: "Path is not in the log file list provided by the Unraid API.",
    };
  }
  try {
    const payload = (await getUnraidClient().request(LOG_FILE_QUERY, {
      path,
      lines: Math.min(1000, Math.max(10, lines)),
    })) as any;
    const content = payload?.logFile;
    return {
      status: "live",
      data: {
        path: content?.path ?? path,
        totalLines: content?.totalLines ?? null,
        startLine: content?.startLine ?? null,
        lines: splitLogLines(content?.content),
      },
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
    };
  } catch (error) {
    return {
      status: "unavailable",
      data: null,
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
      reason: error instanceof Error ? error.message : "unknown error",
    };
  }
}

export async function getConnectionStatus(): Promise<ConnectionStatus> {
  const client: UnraidClient = getUnraidClient();
  const targetHost = (() => {
    try {
      return new URL(client.targetUrl).host;
    } catch {
      return "unknown";
    }
  })();
  const started = Date.now();
  try {
    const payload = (await client.request(CONNECTION_PING_QUERY)) as any;
    return {
      targetHost,
      reachable: payload?.online === true,
      latencyMs: Date.now() - started,
      roles: Array.isArray(payload?.me?.roles) ? payload.me.roles : [],
      lastSuccessAt: new Date().toISOString(),
    };
  } catch {
    return {
      targetHost,
      reachable: false,
      latencyMs: null,
      roles: [],
      lastSuccessAt: null,
    };
  }
}
