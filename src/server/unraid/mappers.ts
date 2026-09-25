import type {
  ArrayDiskUsage,
  DashboardNotification,
  DockerContainerSummary,
  DockerSummary,
  NetworkThroughput,
  NotificationsSummary,
  StorageUsage,
  SystemIdentity,
  CpuUsage,
  MemoryUsage,
} from "./types";

/** GraphQL BigInt serializes as a string. */
function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function kbStringToBytes(value: unknown): number | null {
  const kb = toNumber(value);
  return kb === null ? null : kb * 1024;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- raw GraphQL payloads are
   untyped at the boundary; every access goes through defensive helpers. */

export function mapIdentity(payload: any): SystemIdentity {
  const apiService = Array.isArray(payload?.services)
    ? payload.services.find((service: any) => service?.name === "api")
    : null;
  return {
    serverName: payload?.vars?.name ?? payload?.owner?.username ?? "Unraid server",
    osVersion: payload?.vars?.version ?? null,
    uptimeSeconds: parseUptimeSeconds(apiService?.uptime?.timestamp),
  };
}

/** Uptime arrives either as epoch seconds or an ISO timestamp depending on version. */
function parseUptimeSeconds(value: unknown): number | null {
  const numeric = toNumber(value);
  if (numeric !== null) return numeric;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

export function mapCpu(payload: any): CpuUsage {
  return {
    percentTotal: toNumber(payload?.metrics?.cpu?.percentTotal) ?? 0,
    cores: toNumber(payload?.info?.cpu?.cores),
    brand: payload?.info?.cpu?.brand ?? null,
  };
}

export function mapMemory(payload: any): MemoryUsage {
  const total = toNumber(payload?.metrics?.memory?.total) ?? 0;
  const used = toNumber(payload?.metrics?.memory?.used) ?? 0;
  const percent = toNumber(payload?.metrics?.memory?.percentTotal);
  return {
    totalBytes: total,
    usedBytes: used,
    percentTotal:
      percent ?? (total > 0 ? Math.round((used / total) * 1000) / 10 : 0),
  };
}

export function mapNetwork(payload: any): NetworkThroughput {
  const interfaces: any[] = Array.isArray(payload?.metrics?.network)
    ? payload.metrics.network
    : [];
  // Exclude virtual/loopback-looking interfaces and aggregate the rest.
  const physical = interfaces.filter(
    (iface) => iface?.name && !/^(lo|veth|br-|docker|virbr)/.test(iface.name),
  );
  const target = physical.length > 0 ? physical : interfaces;
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

type RawDisk = Record<string, any>;

function mapDisk(raw: RawDisk, role: ArrayDiskUsage["role"]): ArrayDiskUsage {
  return {
    name: raw?.name ?? raw?.device ?? "unknown",
    role,
    state: raw?.status ?? "UNKNOWN",
    sizeBytes: kbStringToBytes(raw?.fsSize),
    usedBytes: kbStringToBytes(raw?.fsUsed),
    freeBytes: kbStringToBytes(raw?.fsFree),
    temperatureC: toNumber(raw?.temp),
    fsColor: raw?.color ?? null,
  };
}

export function mapStorage(payload: any): StorageUsage {
  const array = payload?.array ?? {};
  const kilobytes = array?.capacity?.kilobytes ?? {};
  const total = kbStringToBytes(kilobytes?.total) ?? 0;
  const used = kbStringToBytes(kilobytes?.used) ?? 0;
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
    state: array?.state ?? "UNKNOWN",
    totalBytes: total,
    usedBytes: used,
    freeBytes: kbStringToBytes(kilobytes?.free) ?? Math.max(0, total - used),
    disks,
    parityStatus: array?.parityCheckStatus?.status ?? "UNKNOWN",
  };
}

const VALID_STATES = new Set(["RUNNING", "PAUSED", "EXITED"]);

export function mapDocker(payload: any): DockerSummary {
  const containers: any[] = Array.isArray(payload?.docker?.containers)
    ? payload.docker.containers
    : [];
  const mapped: DockerContainerSummary[] = containers.map((container, index) => ({
    id: container?.id ?? `container-${index}`,
    name: Array.isArray(container?.names) && container.names.length > 0
      ? container.names[0].replace(/^\//, "")
      : "unknown",
    image: container?.image ?? "unknown",
    state: VALID_STATES.has(container?.state)
      ? container.state
      : "EXITED",
    status: container?.status ?? "",
    autoStart: Boolean(container?.autoStart),
    updateAvailable: Boolean(container?.isUpdateAvailable),
    cpuPercent: null,
    memoryPercent: null,
  }));
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
    recent: recent.slice(0, 8).map((entry, index): DashboardNotification => ({
      id: entry?.id ?? `notification-${index}`,
      title: entry?.title ?? "Notification",
      subject: entry?.subject ?? "",
      description: entry?.description ?? "",
      importance: entry?.importance === "ALERT" ? "ALERT" : entry?.importance === "INFO" ? "INFO" : "WARNING",
      timestamp: entry?.formattedTimestamp ?? entry?.timestamp ?? null,
    })),
  };
}
