/**
 * Domain types consumed by the UI. These are the shapes the BFF API
 * routes return — UI code never touches raw Unraid GraphQL types.
 */

export type LiveStatus = "live" | "unavailable" | "mock";

/** Marker attached to every API payload so the UI can show data provenance. */
export interface Sourced<T> {
  status: LiveStatus;
  data: T;
  /** Present when status !== "live": why we fell back. */
  reason?: string;
  fetchedAt: string;
}

export interface SystemIdentity {
  serverName: string;
  osVersion: string | null;
  uptimeSeconds: number | null;
}

export interface CpuUsage {
  percentTotal: number;
  cores: number | null;
  brand: string | null;
}

export interface MemoryUsage {
  percentTotal: number;
  usedBytes: number;
  totalBytes: number;
}

export interface ArrayDiskUsage {
  name: string;
  role: "parity" | "data" | "cache" | "flash";
  state: string;
  sizeBytes: number | null;
  usedBytes: number | null;
  freeBytes: number | null;
  temperatureC: number | null;
  fsColor: string | null;
}

export interface StorageUsage {
  state: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  disks: ArrayDiskUsage[];
  parityStatus: string;
}

export interface NetworkThroughput {
  rxBytesPerSec: number;
  txBytesPerSec: number;
  totalReceivedBytes: number;
  totalSentBytes: number;
}

export interface DockerContainerSummary {
  id: string;
  name: string;
  image: string;
  state: "RUNNING" | "PAUSED" | "EXITED";
  status: string;
  autoStart: boolean;
  updateAvailable: boolean;
  cpuPercent: number | null;
  memoryPercent: number | null;
}

export interface DockerSummary {
  running: number;
  total: number;
  containers: DockerContainerSummary[];
}

export interface DashboardNotification {
  id: string;
  title: string;
  subject: string;
  description: string;
  importance: "INFO" | "WARNING" | "ALERT";
  timestamp: string | null;
}

export interface NotificationsSummary {
  unreadCounts: { info: number; warning: number; alert: number };
  recent: DashboardNotification[];
}

export interface OverviewSnapshot {
  identity: SystemIdentity;
  cpu: CpuUsage;
  memory: MemoryUsage;
  storage: StorageUsage;
  network: NetworkThroughput;
  docker: DockerSummary;
  notifications: NotificationsSummary;
}

/** A single point in the system resource history chart. */
export interface ResourceSample {
  time: number;
  cpu: number;
  memory: number;
  rx: number;
  tx: number;
}
