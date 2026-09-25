/**
 * Client-safe DTOs returned by the dashboard's own API routes.
 * The browser only ever sees these shapes — never raw Unraid GraphQL
 * payloads, and never any credential material.
 */

export type SourceStatus =
  | "live" // fetched from the Unraid API on this request cycle
  | "stale" // last known good data retained after a fetch failure
  | "unavailable" // fetch failed and no previous data exists
  | "demo"; // placeholder data (API never succeeded since process start)

export interface Section<T> {
  status: SourceStatus;
  data: T | null;
  /** ISO timestamp of the last successful fetch of this section. */
  fetchedAt: string;
  /** Age of the data in ms (0 for live). */
  ageMs: number;
  reason?: string;
}

export interface SystemIdentity {
  serverName: string;
  osVersion: string | null;
  uptimeSeconds: number | null;
}

export interface TemperatureInfo {
  /** CPU package temperature in °C, if a sensor reports it. */
  cpuC: number | null;
  /** Motherboard / ACPI temperature in °C, if reported. */
  boardC: number | null;
  /** Hottest sensor reading in °C. */
  hottestC: number | null;
  /** Number of sensors currently above their warning threshold. */
  warningCount: number;
  /** Number of sensors currently above their critical threshold. */
  criticalCount: number;
}

export interface CpuUsage {
  percentTotal: number;
  cores: number | null;
  threads: number | null;
  brand: string | null;
  temperature: TemperatureInfo | null;
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
  fsType: string | null;
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
  parityStatus: string;
  parityProgressPercent: number | null;
  disks: ArrayDiskUsage[];
}

export interface NetworkThroughput {
  rxBytesPerSec: number;
  txBytesPerSec: number;
  totalReceivedBytes: number;
  totalSentBytes: number;
}

export interface PortMapping {
  privatePort: number | null;
  publicPort: number | null;
  type: string | null;
}

export type ContainerHealth = "healthy" | "unhealthy" | "starting" | null;

export interface DockerContainerSummary {
  id: string;
  name: string;
  image: string;
  state: "RUNNING" | "PAUSED" | "EXITED";
  /** Docker status string, e.g. "Up 2 hours (healthy)". */
  status: string;
  health: ContainerHealth;
  autoStart: boolean;
  updateAvailable: boolean;
  iconUrl: string | null;
  webUiUrl: string | null;
  createdEpochSeconds: number | null;
  ports: PortMapping[];
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
  type: "UNREAD" | "ARCHIVE";
  timestamp: string | null;
}

export interface NotificationsSummary {
  unreadCounts: { info: number; warning: number; alert: number };
  recent: DashboardNotification[];
}

export interface VmInfo {
  id: string;
  name: string;
  state: string;
}

export interface VmsSummary {
  total: number;
  running: number;
  vms: VmInfo[];
}

export interface NetworkInterfaceInfo {
  name: string;
  macAddress: string | null;
  mtu: number | null;
  speedMbps: number | null;
  duplex: string | null;
  virtual: boolean;
  operstate: string | null;
  type: string | null;
  ipAddress: string | null;
  netmask: string | null;
  gateway: string | null;
  useDhcp: boolean | null;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  totalReceivedBytes: number | null;
  totalSentBytes: number | null;
}

export interface SystemInfo {
  hostname: string | null;
  distro: string | null;
  kernel: string | null;
  arch: string | null;
  uefi: boolean | null;
  cpuBrand: string | null;
  cpuCores: number | null;
  cpuThreads: number | null;
  cpuSpeedGhz: number | null;
  memoryTotalBytes: number | null;
  memoryUsedBytes: number | null;
  memoryAvailableBytes: number | null;
  boardManufacturer: string | null;
  boardModel: string | null;
  systemManufacturer: string | null;
  systemModel: string | null;
  virtualized: boolean | null;
  temperature: TemperatureInfo | null;
}

export interface LogFileEntry {
  name: string;
  path: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export interface LogContent {
  path: string;
  totalLines: number | null;
  startLine: number | null;
  lines: string[];
}

export interface ConnectionStatus {
  /** Hostname of the configured Unraid API target — never the API key. */
  targetHost: string;
  reachable: boolean;
  latencyMs: number | null;
  roles: string[];
  lastSuccessAt: string | null;
}

export type HealthLevel = "healthy" | "attention" | "critical" | null;

export interface HealthSummary {
  level: HealthLevel;
  reasons: string[];
}

/** A single point in the server-side metrics history. */
export interface ResourceSample {
  time: number;
  cpu: number;
  memory: number;
  rx: number;
  tx: number;
}

export type HistoryWindow = "5m" | "15m" | "1h";

export interface OverviewPayload {
  identity: Section<SystemIdentity>;
  cpu: Section<CpuUsage>;
  memory: Section<MemoryUsage>;
  temperature: Section<TemperatureInfo>;
  storage: Section<StorageUsage>;
  network: Section<NetworkThroughput>;
  docker: Section<DockerSummary>;
  notifications: Section<NotificationsSummary>;
  health: HealthSummary;
  history: {
    window: HistoryWindow;
    /** Total samples retained in server memory. */
    totalSamples: number;
    /** True once the buffer holds a full window; before that charts cover less time. */
    windowFilled: boolean;
    samples: ResourceSample[];
  };
  generatedAt: string;
}
