/* eslint-disable @typescript-eslint/no-explicit-any -- raw GraphQL payloads at
   the boundary; all access goes through defensive mappers. */
import { getUnraidClient, UnraidClient } from "./client";
import { noteSourceAttempt } from "@/server/incidents/source-health";
import type { ContainerDetailPayload } from "@/lib/api-types";

import {
  str,
  toNumber,
  parseContainerHealth,
  extractComposeProject,
  VALID_CONTAINER_STATES,
} from "./mappers";


import {


  ARRAY_QUERY,
  CONNECTION_PING_QUERY,
  DOCKER_QUERY,
  IDENTITY_QUERY,
  LOG_FILES_QUERY,
  LOG_FILE_QUERY,
  DETAIL_QUERY,
  METRICS_QUERY,
  TEMPERATURE_QUERY,
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
import { getMetricsHistory } from "@/server/history";
import {
  getOverviewExtras,
  getOverviewHistory,
} from "@/server/metrics-service";
import { isPrometheusConfigured } from "@/server/env";
import { getPromClient } from "@/server/prometheus/client";
import { PrometheusError } from "@/server/prometheus/client";
import {
  getContainerMetrics,
  getContainerNetworkThroughput,
  isHighMemory,
  type ContainerNetworkRate,
} from "@/server/prometheus/containers";
import type { ContainerMetrics, MetricMeta } from "@/lib/api-types";
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
  memoryAvailableBytes: number | null;
  memoryTotalBytes: number;
  throughput: NetworkThroughput;
  interfaces: any;
  infoCpu: any;
}

const metricsProvider = new SectionProvider<RawMetrics>(
  "metrics",
  async () => {
    const client = getUnraidClient();
    const payload = await client.request(METRICS_QUERY);
    // Canonical Linux semantics (v0.9.7): used = total − available, and
    // usedPercent is DERIVED from that pair, so the invariant
    // usedBytes / totalBytes ≈ percentTotal holds by construction.
    // Unraid's own percentTotal already follows (total − available)/total,
    // but its `used` is MemTotal − MemFree (cache-inclusive); mixing the
    // two produced contradictory UI values (78% beside "60 of 62 GiB").
    const totalBytes = Number((payload as any)?.metrics?.memory?.total ?? 0);
    const availableRaw = (payload as any)?.metrics?.memory?.available;
    const availableBytes =
      availableRaw == null ? null : Math.max(0, Number(availableRaw) || 0);
    const usedBytes =
      availableBytes != null && totalBytes > 0
        ? Math.max(0, totalBytes - availableBytes)
        : Number((payload as any)?.metrics?.memory?.used ?? 0);
    return {
      cpuPercent: (payload as any)?.metrics?.cpu?.percentTotal ?? 0,
      memoryPercent:
        totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100000) / 1000 : 0,
      memoryUsedBytes: usedBytes,
      memoryAvailableBytes: availableBytes,
      memoryTotalBytes: totalBytes,
      throughput: mapNetworkThroughput(payload),
      interfaces: (payload as any)?.metrics?.network,
      infoCpu: (payload as any)?.info?.cpu,
    };
  },
  5_000,
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

/* Standby-aware temperature collector: own section + 15 min TTL, so the
   SMART/sensor resolution no longer rides along with every metrics poll. */
const temperatureProvider = new SectionProvider<TemperatureInfo>(
  "temperature",
  async () => mapTemperature(await getUnraidClient().request(TEMPERATURE_QUERY)),
  15 * 60_000,
);

async function getTemperatureSection(): Promise<Section<TemperatureInfo>> {
  return temperatureProvider.get();
}

const identityProvider = new SectionProvider<SystemIdentity>(
  "identity",
  async () => mapIdentity(await getUnraidClient().request(IDENTITY_QUERY)),
  60_000,
);

const storageProvider = new SectionProvider<StorageUsage>(
  "storage",
  async () => mapStorage(await getUnraidClient().request(ARRAY_QUERY)),
  60_000,
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
  60_000,
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
    // Exactly one SYSTEM_QUERY + one ride-along per section per refresh —
    // duplicated array entries used to fire the same query twice.
    const [infoPayload, metricsSection, tempSection] = await Promise.all([
      client.request(SYSTEM_QUERY),
      getMetricsSection(),
      getTemperatureSection(),
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
      temperature: tempSection.data ?? null,
    };
  },
  30_000,
);

/* Demo substitution ----------------------------------------------------- */

/**
 * Demo substitution contract (see mock.ts and section.ts): demo data is
 * shown only while the Unraid API has NEVER responded this process. A live
 * server with one failing section (missing key role, query error, a boot
 * race after another section succeeded) shows that section as unavailable —
 * an honest degraded state — never as demo. Prometheus, helper and history
 * failures never gate demo: they only feed enrichments.
 */
function unraidDemoActive(): boolean {
  return !(
    identityProvider.hasLive ||
    metricsProvider.hasLive ||
    storageProvider.hasLive ||
    dockerProvider.hasLive ||
    notificationsProvider.hasLive ||
    vmsProvider.hasLive ||
    systemProvider.hasLive
  );
}

/** Pure demo-substitution decision, exported for regression tests. */
export function applyDemoSubstitution<T>(
  demoActive: boolean,
  section: Section<T>,
  demoData: T,
): Section<T> {
  if (demoActive && section.status === "unavailable") {
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

function withDemo<T>(section: Section<T>, demoData: T): Section<T> {
  return applyDemoSubstitution(unraidDemoActive(), section, demoData);
}

/** lastSuccessAt per provider, for the diagnostics view. */
export function sectionLastSuccess(): Record<string, number | null> {
  const providers: Array<[string, { lastSuccess: number | null }]> = [
    ["metrics", metricsProvider],
    ["identity", identityProvider],
    ["storage", storageProvider],
    ["docker", dockerProvider],
    ["notifications", notificationsProvider],
    ["vms", vmsProvider],
    ["system", systemProvider],
  ];
  return Object.fromEntries(
    providers.map(([name, provider]) => [name, provider.lastSuccess]),
  );
}

/* Public API ------------------------------------------------------------ */

export async function getOverview(
  historyWindow: HistoryWindow = "15m",
): Promise<OverviewPayload> {
  const [identity, metrics, storage, dockerWithMetrics, notifications] =
    await Promise.all([
      identityProvider.get(),
      getMetricsSection(),
      storageProvider.get(),
      getDockerWithMetrics(),
      notificationsProvider.get(),
    ]);
  const docker = dockerWithMetrics.section;

  const memory: Section<{
    percentTotal: number;
    usedBytes: number;
    totalBytes: number;
    availableBytes: number | null;
  }> = metrics.data
    ? {
        status: metrics.status,
        data: {
          percentTotal: metrics.data.memoryPercent,
          usedBytes: metrics.data.memoryUsedBytes,
          totalBytes: metrics.data.memoryTotalBytes,
          availableBytes: metrics.data.memoryAvailableBytes,
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

  const temperatureSection = await getTemperatureSection();

  const cpuSection = {
    ...metrics,
    data: metrics.data
      ? mapCpu(
          { metrics: {}, info: { cpu: metrics.data.infoCpu } },
          temperatureSection.data ?? null,
        )
      : null,
  };
  if (cpuSection.data) {
    cpuSection.data.percentTotal = metrics.data!.cpuPercent;
  }


  const networkSection: Section<NetworkThroughput> = {
    ...metrics,
    data: metrics.data ? metrics.data.throughput : null,
  };

  const history = getMetricsHistory();
  const inMemorySamples: ResourceSample[] = history.slice(historyWindow);

  /* Prometheus enrichments — fetched with their own caches and never
     fatal: the payload below works with or without them. */
  const [extras, promHistory] = await Promise.all([
    getOverviewExtras({
      unhealthyContainers: docker.data
        ? docker.data.containers.filter((c) => c.health === "unhealthy").length
        : null,
      highMemoryContainers: docker.data
        ? docker.data.containers.filter((c) => isHighMemory(c.metrics)).length
        : null,
    }).catch(() => null),
    getOverviewHistory(historyWindow).catch(() => null),
  ]);

  let historyBlock: OverviewPayload["history"] = {
    window: historyWindow,
    totalSamples: history.totalSamples,
    windowFilled: history.windowFilled(historyWindow),
    samples: inMemorySamples,
    source: "derived",
    status: extras?.prometheus.configured
      ? "unavailable"
      : "live",
    reason: extras?.prometheus.configured
      ? extras.prometheus.reason ?? "Prometheus unavailable — showing the in-memory buffer"
      : undefined,
  };
  if (promHistory && promHistory.samples.length >= 2) {
    historyBlock = {
      window: historyWindow,
      totalSamples: promHistory.samples.length,
      windowFilled: promHistory.windowFilled,
      samples: promHistory.samples,
      source: "prometheus",
      status: promHistory.meta.status,
      reason: promHistory.meta.reason,
    };
  }

  // Prefer the Unraid-side memory % (authoritative); Prometheus load/thermal enrich only.
  // v1.5.0: health is DERIVED FROM INCIDENTS — the engine evaluates rules
  // over this payload (cached data only) and produces the verdict, so the
  // Overview, Incident Center and notifications share ONE source of truth.
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
    health: { level: null, reasons: [] },
    history: historyBlock,
    extras: extras ?? null,
    generatedAt: new Date().toISOString(),
  };

  const { runIncidentCycle } = await import("@/server/incidents/cycle");
  const incidentSnapshot = await runIncidentCycle(payload);
  payload.health = incidentSnapshot.health;
  return payload;
}

/**
 * Docker section joined with Prometheus runtime metrics by container
 * name. Unraid remains the authoritative source for lifecycle state;
 * metrics carry their own provenance block and degrade independently.
 */
/**
 * Docker section joined with Prometheus runtime metrics by container
 * name. Unraid remains the authoritative source for lifecycle state;
 * metrics carry their own provenance block and degrade independently.
 */
async function getContainerMetricsJoined(): Promise<{
  metrics: Map<string, ContainerMetrics>;
  meta: MetricMeta;
}> {
  if (!isPrometheusConfigured()) {
    return {
      metrics: new Map(),
      meta: {
        source: "prometheus",
        status: "unavailable",
        sampledAt: new Date().toISOString(),
        reason: "Prometheus is not configured (PROMETHEUS_URL missing)",
      },
    };
  }
  try {
    const [metrics, network] = await Promise.all([
      getContainerMetrics(getPromClient()),
      getContainerNetworkThroughput().catch(() => new Map<string, ContainerNetworkRate>()),
    ]);
    // Join network rates into the metric rows.
    for (const [joinName, rate] of network) {
      const existing = metrics.get(joinName);
      if (existing) {
        metrics.set(joinName, {
          ...existing,
          networkRxBytesPerSec: rate.reliable ? rate.rxBytesPerSec : null,
          networkTxBytesPerSec: rate.reliable ? rate.txBytesPerSec : null,
          networkReliable: rate.reliable,
        });
      }
    }
    return {
      metrics,
      meta: {
        source: "prometheus",
        status: "live",
        sampledAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    return {
      metrics: new Map(),
      meta: {
        source: "prometheus",
        status: "unavailable",
        sampledAt: new Date().toISOString(),
        reason:
          error instanceof PrometheusError
            ? `${error.kind}: ${error.message}`
            : error instanceof Error
              ? error.message
              : "unknown Prometheus error",
      },
    };
  }
}

export async function getDockerWithMetrics(): Promise<{
  section: Section<DockerSummary>;
}> {
  const base = await dockerProvider.get();
  if (!base.data) {
    return { section: withDemo(base, demo.docker) };
  }
  const summary = base.data;
  const metricsResult = await getContainerMetricsJoined();
  const containers = summary.containers.map((container) => ({
    ...container,
    metrics: metricsResult.metrics.get(container.name) ?? null,
  }));
  const next: DockerSummary = {
    ...summary,
    containers,
    metricsMeta: metricsResult.meta,
  };
  return {
    section: {
      ...base,
      data: next,
    },
  };
}

/** Counts derived from joined metrics, used by Overview + health. */
export async function getDockerMetricCounts(): Promise<{
  unhealthy: number;
  highMemory: number;
}> {
  const { section } = await getDockerWithMetrics();
  const containers = section.data?.containers ?? [];
  return {
    unhealthy: containers.filter((c) => c.health === "unhealthy").length,
    highMemory: containers.filter((c) => isHighMemory(c.metrics)).length,
  };
}

export async function getDocker(): Promise<Section<DockerSummary>> {
  return withDemo(await dockerProvider.get(), demo.docker);
}

export async function getStorage(): Promise<Section<StorageUsage>> {
  return withDemo(await storageProvider.get(), demo.storage);
}

/* Module-level provider: a per-call SectionProvider would TTL-cache nothing
   (a fresh instance per request always refetches — an Unraid request per
   network poll). */
const networkInterfacesProvider = new SectionProvider<any>(
  "network-interfaces",
  async () => await getUnraidClient().request(NETWORK_INTERFACES_QUERY),
  10_000,
);

export async function getNetwork(): Promise<Section<NetworkInterfaceInfo[]>> {
  const [interfaces, metrics] = await Promise.all([
    networkInterfacesProvider.get(),
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
    const latencyMs = Date.now() - started;
    // v1.6.0 source-performance ring (bounded, in-memory).
    noteSourceAttempt("unraid-api", { ok: payload?.online === true, at: Date.now(), latencyMs });
    return {
      targetHost,
      reachable: payload?.online === true,
      latencyMs,
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

/* v0.4: container detail --------------------------------------------------- */



/**
 * Full detail for one container by name, from the live Unraid API.
 * Read-only; JSON blobs (mounts/networkSettings/labels) are reduced to
 * safe display shapes. Environment variables are not exposed by the API
 * schema at all.
 */
export async function getContainerDetail(name: string): Promise<Section<ContainerDetailPayload | null>> {
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
  if (!valid) {
    return {
      status: "unavailable",
      data: null,
      fetchedAt: new Date().toISOString(),
      ageMs: 0,
      reason: "Invalid container name.",
    };
  }
  try {
    const payload = await getUnraidClient().request(DETAIL_QUERY);
    const containers: any[] = Array.isArray((payload as any)?.docker?.containers)
      ? (payload as any).docker.containers
      : [];
    const match = containers.find(
      (container) =>
        Array.isArray(container?.names) &&
        String(container.names[0] ?? "").replace(/^\//, "") === name,
    );
    if (!match) {
      return {
        status: "live",
        data: null,
        fetchedAt: new Date().toISOString(),
        ageMs: 0,
      };
    }
    const status = str(match?.status);
    const mounts = Array.isArray(match?.mounts) ? match.mounts : [];
    const ns = match?.networkSettings ?? {};
    const networksRaw = ns?.networks ?? {};
    const labelsRaw = match?.labels ?? {};
    const labels: Record<string, string> = {};
    if (labelsRaw && typeof labelsRaw === "object") {
      for (const [key, value] of Object.entries(labelsRaw as Record<string, unknown>)) {
        labels[key] = String(value ?? "");
      }
    }
    return {
      status: "live",
      data: {
        id: str(match?.id) ?? "unknown",
        name,
        image: str(match?.image) ?? "unknown",
        command: str(match?.command),
        state: VALID_CONTAINER_STATES.has(match?.state) ? match.state : "EXITED",
        status: status ?? "",
        health: parseContainerHealth(status),
        autoStart: Boolean(match?.autoStart),
        updateAvailable: Boolean(match?.isUpdateAvailable),
        iconUrl: str(match?.iconUrl),
        webUiUrl: str(match?.webUiUrl),
        createdEpochSeconds: toNumber(match?.created),
        composeProject: extractComposeProject(match?.labels),
        ports: (Array.isArray(match?.ports) ? match.ports : [])
          .map((port: any) => ({
            privatePort: toNumber(port?.privatePort),
            publicPort: toNumber(port?.publicPort),
            type: str(port?.type),
          }))
          .filter(
            (port: { privatePort: number | null; publicPort: number | null }) =>
              port.privatePort !== null || port.publicPort !== null,
          ),
        mounts: mounts
          .map((mount: any) => ({
            type: str(mount?.Type) ?? str(mount?.type),
            source: str(mount?.Source) ?? str(mount?.source),
            destination: str(mount?.Destination) ?? str(mount?.destination),
            rw: typeof mount?.RW === "boolean" ? mount.RW : null,
          }))
          .slice(0, 30),
        networks: Object.entries(networksRaw as Record<string, any>)
          .map(([networkName, network]) => ({
            name: networkName,
            ip: str(network?.IPAddress),
            gateway: str(network?.Gateway),
            mac: str(network?.MacAddress) ?? str(network?.DeviceMacAddress),
          }))
          .slice(0, 10),
        labels,
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
