import type {
  ArrayDiskUsage,
  CpuUsage,
  DashboardNotification,
  DockerContainerSummary,
  DockerSummary,
  MemoryUsage,
  NetworkInterfaceInfo,
  NetworkThroughput,
  NotificationsSummary,
  StorageUsage,
  SystemIdentity,
  SystemInfo,
  TemperatureInfo,
  VmsSummary,
  ContainerHealth,
} from "@/lib/api-types";

/**
 * Mappers from raw (untyped) GraphQL payloads to frontend-safe DTOs.
 * All access is defensive: optional fields may be missing on any
 * Unraid version, and malformed values must not crash a section.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- raw GraphQL boundary */

/** GraphQL BigInt serializes as a string (sometimes number). */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Array capacity is reported in kilobytes. */
function kbToBytes(value: unknown): number | null {
  const kb = toNumber(value);
  return kb === null ? null : kb * 1024;
}

export function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Uptime arrives either as epoch seconds or an ISO timestamp. */
function parseUptimeSeconds(value: unknown): number | null {
  const numeric = toNumber(value);
  if (numeric !== null) return numeric;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

export function mapIdentity(payload: any): SystemIdentity {
  const apiService = Array.isArray(payload?.services)
    ? payload.services.find(
        (service: any) => service?.name === "unraid-api" || service?.name === "api",
      )
    : null;
  return {
    serverName:
      str(payload?.vars?.name) ?? str(payload?.owner?.username) ?? "Unraid server",
    osVersion: str(payload?.vars?.version),
    uptimeSeconds: parseUptimeSeconds(apiService?.uptime?.timestamp),
  };
}

export function mapTemperature(payload: any): TemperatureInfo {
  const sensors: any[] = Array.isArray(payload?.metrics?.temperature?.sensors)
    ? payload.metrics.temperature.sensors
    : [];
  const summary = payload?.metrics?.temperature?.summary ?? {};
  const byType = (type: string) =>
    sensors
      .filter((sensor) => sensor?.type === type)
      .map((sensor) => toNumber(sensor?.current?.value))
      .filter((value): value is number => value !== null);
  const cpuReadings = byType("CPU_PACKAGE");
  const boardReadings = sensors
    .filter((sensor) => sensor?.type !== "CPU_PACKAGE" && sensor?.type !== "CPU_CORE")
    .map((sensor) => toNumber(sensor?.current?.value))
    .filter((value): value is number => value !== null);
  return {
    cpuC: cpuReadings.length > 0 ? Math.max(...cpuReadings) : null,
    boardC: boardReadings.length > 0 ? Math.max(...boardReadings) : null,
    hottestC: toNumber(summary?.hottest?.current?.value),
    warningCount: toNumber(summary?.warningCount) ?? 0,
    criticalCount: toNumber(summary?.criticalCount) ?? 0,
  };
}

export function mapCpu(payload: any, temperature: TemperatureInfo | null): CpuUsage {
  return {
    percentTotal: toNumber(payload?.metrics?.cpu?.percentTotal) ?? 0,
    cores: toNumber(payload?.info?.cpu?.cores),
    threads: toNumber(payload?.info?.cpu?.threads),
    brand: str(payload?.info?.cpu?.brand),
    temperature,
  };
}

export function mapMemory(payload: any): MemoryUsage {
  // Canonical Linux semantics (v0.9.7): used = total − available, and
  // percentTotal is derived from that pair, so
  // usedBytes / totalBytes ≈ percentTotal always holds. The upstream
  // `used` (MemTotal − MemFree) is cache-inclusive and contradicted the
  // available-based percent when displayed next to it.
  const total = toNumber(payload?.metrics?.memory?.total) ?? 0;
  const availableRaw = toNumber(payload?.metrics?.memory?.available);
  const available = availableRaw == null ? null : Math.max(0, availableRaw);
  const used =
    available != null && total > 0
      ? Math.max(0, total - available)
      : toNumber(payload?.metrics?.memory?.used) ?? 0;
  const usedBytes = total > 0 && available != null ? Math.min(used, total) : used;
  return {
    totalBytes: total,
    usedBytes,
    availableBytes:
      available != null && total > 0 ? Math.max(0, total - usedBytes) : null,
    percentTotal: total > 0 ? Math.round((usedBytes / total) * 1000) / 10 : 0,
  };
}

export function mapMemoryDetail(payload: any): {
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
} {
  // System page uses DIMM layout total (info.memory); metrics.memory may be absent.
  const layout: any[] = Array.isArray(payload?.info?.memory?.layout)
    ? payload.info.memory.layout
    : [];
  const totalBytes = layout.reduce(
    (sum, dimm) => sum + (toNumber(dimm?.size) ?? 0),
    0,
  );
  return {
    totalBytes: totalBytes > 0 ? totalBytes : null,
    usedBytes: null,
    availableBytes: null,
  };
}

/** Interfaces that are physical-ish; used for aggregate throughput. */
const VIRTUAL_IFACE_PATTERN = /^(lo|veth|br-|docker|virbr|tun|tap|wg|mesh)/;

export function selectThroughputInterfaces(interfaces: any[]): any[] {
  const physical = interfaces.filter(
    (iface) => typeof iface?.name === "string" && !VIRTUAL_IFACE_PATTERN.test(iface.name),
  );
  return physical.length > 0 ? physical : interfaces;
}

export function mapNetworkThroughput(payload: any): NetworkThroughput {
  const interfaces: any[] = Array.isArray(payload?.metrics?.network)
    ? payload.metrics.network
    : [];
  const target = selectThroughputInterfaces(interfaces);
  return {
    rxBytesPerSec: target.reduce(
      (sum, iface) => sum + (toNumber(iface?.rxSec) ?? 0),
      0,
    ),
    txBytesPerSec: target.reduce(
      (sum, iface) => sum + (toNumber(iface?.txSec) ?? 0),
      0,
    ),
    totalReceivedBytes: target.reduce(
      (sum, iface) => sum + (toNumber(iface?.bytesReceived) ?? 0),
      0,
    ),
    totalSentBytes: target.reduce(
      (sum, iface) => sum + (toNumber(iface?.bytesSent) ?? 0),
      0,
    ),
  };
}

export function mapNetworkInterfaces(
  payload: any,
  metrics: any,
): NetworkInterfaceInfo[] {
  const interfaces: any[] = Array.isArray(payload?.networkInterfaces)
    ? payload.networkInterfaces
    : [];
  const rates = new Map<string, any>();
  for (const iface of Array.isArray(metrics?.network) ? metrics.network : []) {
    if (typeof iface?.name === "string") rates.set(iface.name, iface);
  }
  return interfaces.map((iface) => {
    const rate = rates.get(iface?.name);
    return {
      name: str(iface?.name) ?? "unknown",
      macAddress: str(iface?.macAddress),
      mtu: toNumber(iface?.mtu),
      speedMbps: toNumber(iface?.speed),
      duplex: str(iface?.duplex),
      virtual: Boolean(iface?.virtual),
      operstate: str(iface?.operstate),
      type: str(iface?.type),
      ipAddress: str(iface?.ipAddress),
      netmask: str(iface?.netmask),
      gateway: str(iface?.gateway),
      useDhcp:
        typeof iface?.useDhcp === "boolean" ? iface.useDhcp : null,
      rxBytesPerSec: toNumber(rate?.rxSec),
      txBytesPerSec: toNumber(rate?.txSec),
      totalReceivedBytes: toNumber(rate?.bytesReceived),
      totalSentBytes: toNumber(rate?.bytesSent),
    };
  });
}

type RawDisk = Record<string, any>;

function mapDisk(raw: RawDisk, role: ArrayDiskUsage["role"]): ArrayDiskUsage {
  return {
    name: str(raw?.name) ?? str(raw?.device) ?? "unknown",
    device: str(raw?.device),
    role,
    state: str(raw?.status) ?? "UNKNOWN",
    fsType: str(raw?.fsType),
    sizeBytes: kbToBytes(raw?.fsSize),
    usedBytes: kbToBytes(raw?.fsUsed),
    freeBytes: kbToBytes(raw?.fsFree),
    temperatureC: toNumber(raw?.temp),
    fsColor: str(raw?.color),
  };
}

export function mapStorage(payload: any): StorageUsage {
  const array = payload?.array ?? {};
  const kilobytes = array?.capacity?.kilobytes ?? {};
  const total = kbToBytes(kilobytes?.total) ?? 0;
  const used = kbToBytes(kilobytes?.used) ?? 0;
  const free = kbToBytes(kilobytes?.free);
  const disks: ArrayDiskUsage[] = [
    ...(Array.isArray(array?.parities) ? array.parities : []).map((disk: RawDisk) =>
      mapDisk(disk, "parity"),
    ),
    ...(Array.isArray(array?.disks) ? array.disks : []).map((disk: RawDisk) =>
      mapDisk(disk, "data"),
    ),
    ...(Array.isArray(array?.caches) ? array.caches : []).map((disk: RawDisk) =>
      mapDisk(disk, "cache"),
    ),
    ...(array?.boot ? [mapDisk(array.boot, "flash")] : []),
  ];
  return {
    state: str(array?.state) ?? "UNKNOWN",
    totalBytes: total,
    usedBytes: used,
    freeBytes: free ?? Math.max(0, total - used),
    parityStatus: str(array?.parityCheckStatus?.status) ?? "UNKNOWN",
    parityProgressPercent: toNumber(array?.parityCheckStatus?.progress),
    disks,
  };
}

/** Parses Docker's human status string for health, e.g. "Up 2 hours (healthy)". */
export function parseContainerHealth(status: string | null): ContainerHealth {
  if (!status) return null;
  if (/\(healthy\)/i.test(status)) return "healthy";
  if (/\(unhealthy\)/i.test(status)) return "unhealthy";
  if (/\(health:\s*starting\)/i.test(status)) return "starting";
  return null;
}

export const VALID_CONTAINER_STATES = new Set(["RUNNING", "PAUSED", "EXITED"]);

/**
 * Extracts the Docker Compose project from the raw `labels` JSON the
 * Unraid API returns (a scalar object). Grouping comes from real
 * compose labels only — never guessed from name prefixes.
 */
export function extractComposeProject(labels: unknown): string | null {
  if (labels === null || typeof labels !== "object") return null;
  const record = labels as Record<string, unknown>;
  const project = record["com.docker.compose.project"];
  return typeof project === "string" && project.length > 0 ? project : null;
}

export function mapDocker(payload: any): DockerSummary {
  const containers: any[] = Array.isArray(payload?.docker?.containers)
    ? payload.docker.containers
    : [];
  const mapped: DockerContainerSummary[] = containers.map(
    (container, index): DockerContainerSummary => {
      const status = str(container?.status);
      return {
        id: str(container?.id) ?? `container-${index}`,
        name:
          Array.isArray(container?.names) && container.names.length > 0
            ? String(container.names[0]).replace(/^\//, "")
            : "unknown",
        image: str(container?.image) ?? "unknown",
        state: VALID_CONTAINER_STATES.has(container?.state)
          ? container.state
          : "EXITED",
        status: status ?? "",
        health: parseContainerHealth(status),
        autoStart: Boolean(container?.autoStart),
        updateAvailable: Boolean(container?.isUpdateAvailable),
        iconUrl: str(container?.iconUrl),
        webUiUrl: str(container?.webUiUrl),
        createdEpochSeconds: toNumber(container?.created),
        composeProject: extractComposeProject(container?.labels),
        metrics: null,
        ports: (Array.isArray(container?.ports) ? container.ports : [])
          .map((port: any) => ({
            privatePort: toNumber(port?.privatePort),
            publicPort: toNumber(port?.publicPort),
            type: str(port?.type),
          }))
          .filter(
            (port: { privatePort: number | null; publicPort: number | null }) =>
              port.privatePort !== null || port.publicPort !== null,
          ),
      };
    },
  );
  return {
    running: mapped.filter((container) => container.state === "RUNNING").length,
    total: mapped.length,
    containers: mapped,
  };
}

export function mapNotifications(payload: any): NotificationsSummary {
  const notifications = payload?.notifications ?? {};
  const unread = notifications?.overview?.unread ?? {};
  const recent: any[] = Array.isArray(notifications?.warningsAndAlerts)
    ? notifications.warningsAndAlerts
    : [];
  return {
    unreadCounts: {
      info: toNumber(unread?.info) ?? 0,
      warning: toNumber(unread?.warning) ?? 0,
      alert: toNumber(unread?.alert) ?? 0,
    },
    recent: recent.slice(0, 8).map(mapNotification),
  };
}

export function mapNotification(entry: any, index = 0): DashboardNotification {
  return {
    id: str(entry?.id) ?? `notification-${index}`,
    title: str(entry?.title) ?? "Notification",
    subject: str(entry?.subject) ?? "",
    description: str(entry?.description) ?? "",
    importance:
      entry?.importance === "ALERT"
        ? "ALERT"
        : entry?.importance === "INFO"
          ? "INFO"
          : "WARNING",
    type: entry?.type === "ARCHIVE" ? "ARCHIVE" : "UNREAD",
    timestamp: str(entry?.formattedTimestamp) ?? str(entry?.timestamp),
  };
}

export function mapVms(payload: any): VmsSummary {
  const domains: any[] = Array.isArray(payload?.vms?.domains)
    ? payload.vms.domains
    : [];
  return {
    total: domains.length,
    running: domains.filter((domain) => domain?.state === "RUNNING").length,
    vms: domains.map((domain, index) => ({
      id: str(domain?.id) ?? `vm-${index}`,
      name: str(domain?.name) ?? "unknown",
      state: str(domain?.state) ?? "UNKNOWN",
    })),
  };
}

export function mapSystemInfo(payload: any): SystemInfo {
  const os = payload?.info?.os ?? {};
  const cpu = payload?.info?.cpu ?? {};
  const board = payload?.info?.baseboard ?? {};
  const system = payload?.info?.system ?? {};
  return {
    hostname: str(os?.hostname),
    distro: str(os?.distro),
    kernel: str(os?.kernel),
    arch: str(os?.arch),
    uefi: typeof os?.uefi === "boolean" ? os.uefi : null,
    cpuBrand: str(cpu?.brand),
    cpuCores: toNumber(cpu?.cores),
    cpuThreads: toNumber(cpu?.threads),
    cpuSpeedGhz: toNumber(cpu?.speed),
    memoryTotalBytes: null, // filled by caller from metrics.memory
    memoryUsedBytes: null,
    memoryAvailableBytes: null,
    boardManufacturer: str(board?.manufacturer),
    boardModel: str(board?.model),
    systemManufacturer: str(system?.manufacturer),
    systemModel: str(system?.model),
    virtualized: typeof system?.virtual === "boolean" ? system.virtual : null,
    temperature: null, // filled by caller from metrics.temperature
  };
}

export function mapLogFiles(payload: any) {
  const files: any[] = Array.isArray(payload?.logFiles) ? payload.logFiles : [];
  return files.map((file) => ({
    name: str(file?.name) ?? "unknown",
    path: str(file?.path) ?? "",
    sizeBytes: toNumber(file?.size),
    modifiedAt: str(file?.modifiedAt),
  }));
}

export function splitLogLines(content: unknown): string[] {
  if (typeof content !== "string" || content.length === 0) return [];
  return content.split("\n").filter((line) => line.length > 0);
}
