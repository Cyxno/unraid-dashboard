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
  /** Kernel device (e.g. "sdb") — the join key for Prometheus disk I/O. */
  device: string | null;
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
  /** Compose project from com.docker.compose.project label, if any. */
  composeProject: string | null;
  /**
   * Runtime metrics joined from Prometheus by container name. Null when
   * Prometheus is unavailable or the container has no metric rows.
   */
  metrics: ContainerMetrics | null;
}

export interface DockerSummary {
  running: number;
  total: number;
  containers: DockerContainerSummary[];
  /** Provenance for the joined runtime metrics (absent pre-v0.3 shape). */
  metricsMeta?: MetricMeta;
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

/** Time windows for history views (Prometheus-backed since v0.3). */
export type HistoryWindow = "5m" | "15m" | "1h" | "6h" | "24h" | "7d";

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
    /** Where this history came from; "in-memory" only during Prometheus outages. */
    source: MetricSource;
    status: LiveStatus;
    reason?: string;
  };
  /** v0.3 Prometheus-derived enrichments. Absent fields = unavailable. */
  extras: OverviewExtras | null;
  generatedAt: string;
}

/* ==========================================================================
 * v0.3 observability types — Prometheus-derived metrics
 * ==========================================================================
 * History and runtime metrics come from a Prometheus server (PROMETHEUS_URL).
 * When Prometheus is not configured or unreachable these sections carry
 * status "unavailable"/"stale" with a reason — the UI shows them as such
 * and never fabricates replacement data.
 */

/** Where a metric (or metric family) comes from. */
export type MetricSource = "unraid" | "prometheus" | "derived";

export type LiveStatus = "live" | "stale" | "unavailable";

/** Provenance + freshness block attached to Prometheus-derived payloads. */
export interface MetricMeta {
  source: MetricSource;
  status: LiveStatus;
  /** ISO timestamp of the successful Prometheus fetch behind this data. */
  sampledAt: string;
  /** Present when status is "stale"/"unavailable". */
  reason?: string;
}

/** One point in a time series. Null = no sample (gap) at that time. */
export interface HistoryPoint {
  /** Epoch milliseconds. */
  t: number;
  /** Value, or null when Prometheus had no sample. */
  v: number | null;
}

/** A labeled series (e.g. per core, per device, per sensor). */
export interface NamedSeries {
  /** Display name, e.g. "cpu0", "sda", "Package id 0". */
  name: string;
  /** Extra labels (device, chip, …) for tooltips/debug. */
  labels?: Record<string, string>;
  points: HistoryPoint[];
}

/* System snapshot ---------------------------------------------------------- */

export interface PerCoreCpu {
  /** Core/thread identifier as reported ("0", "1", …). */
  id: string;
  percent: number | null;
}

export type LoadLevel = "normal" | "elevated" | "high" | null;

export interface LoadInfo {
  one: number | null;
  five: number | null;
  fifteen: number | null;
  /** CPU thread count used to contextualize load. */
  threads: number | null;
  /** Thread-count-relative classification (see server/thresholds.ts). */
  level: LoadLevel;
}

export interface MemoryBreakdown {
  totalBytes: number | null;
  usedBytes: number | null;
  availableBytes: number | null;
  cachedBytes: number | null;
  buffersBytes: number | null;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
}

export type ThermalCategory =
  | "package"
  | "core"
  | "board"
  | "disk"
  | "other";

export interface ThermalSensor {
  /** Stable id: `${chip}/${sensor}`. */
  id: string;
  /** Human-readable sensor name ("Package id 0", "temp1", …). */
  name: string;
  chip: string;
  category: ThermalCategory;
  currentC: number | null;
}

export interface ThermalSnapshot {
  packageC: number | null;
  boardC: number | null;
  /** Hottest sensor reading across all categories. */
  hottestC: number | null;
  /** Hottest sensor name (for the Overview card). */
  hottestName: string | null;
  /** Platform power draw in watts, when the exporter reports it. */
  powerWatts: number | null;
  sensors: ThermalSensor[];
}

export interface SystemMetricsSnapshot {
  meta: MetricMeta;
  cpuPercent: number | null;
  perCore: PerCoreCpu[];
  load: LoadInfo;
  memory: MemoryBreakdown;
  thermal: ThermalSnapshot;
  /** Host uptime seconds from node_exporter (cross-check for Unraid). */
  uptimeSeconds: number | null;
}

/** Payload of /api/system/history — one metric family per request. */
export type SystemHistoryMetric =
  | "cpu"
  | "memory"
  | "load"
  | "network"
  | "disk"
  | "temps";

export interface SystemHistoryPayload {
  meta: MetricMeta;
  window: string;
  stepSeconds: number;
  metric: SystemHistoryMetric;
  /** Primary aggregate series (units noted per metric). */
  series: NamedSeries[];
  /** Per-entity series (cores, devices, sensors, interfaces). */
  breakdown: NamedSeries[];
  /** min/max over the window where computable (temps, cpu). */
  summary?: {
    min: number | null;
    max: number | null;
    avg: number | null;
  };
  /** For metric="temps": per-sensor stats over the window. */
  sensorStats?: Array<{
    id: string;
    name: string;
    category: string;
    min: number | null;
    max: number | null;
    current: number | null;
  }>;
}

/* Container runtime metrics ------------------------------------------------- */

export interface ContainerMetrics {
  /** Live CPU% from docker stats (textfile gauge). */
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryLimitBytes: number | null;
  /**
   * Percent of the container's own limit. Null when the limit is the
   * host total (unlimited) — never a fake percentage of host RAM.
   */
  memoryPercentOfLimit: number | null;
  /** True when the container has a real (non-host) memory limit. */
  hasMemoryLimit: boolean;
  /** Absolute memory percent of host RAM (docker stats semantics). */
  memoryPercentOfHost: number | null;
  /**
   * Per-container network RX/TX (cAdvisor). Null/unreliable for
   * host-networked containers — the numbers would be host-wide.
   */
  networkRxBytesPerSec: number | null;
  networkTxBytesPerSec: number | null;
  networkReliable: boolean;
}

export interface ContainerHistoryPayload {
  meta: MetricMeta;
  window: string;
  stepSeconds: number;
  name: string;
  cpu: HistoryPoint[];
  memoryBytes: HistoryPoint[];
  /** Null when the container is host-networked (unreliable). */
  network: { rx: HistoryPoint[]; tx: HistoryPoint[] } | null;
}

/** Top consumers widget payload. */
export interface TopConsumers {
  meta: MetricMeta;
  cpu: Array<{ name: string; percent: number | null }>;
  memory: Array<{ name: string; bytes: number | null }>;
}

/* Network / storage history -------------------------------------------------- */

export interface InterfaceHistoryPayload {
  meta: MetricMeta;
  window: string;
  stepSeconds: number;
  interfaces: Array<{
    name: string;
    rxPoints: HistoryPoint[];
    txPoints: HistoryPoint[];
  }>;
}

export interface DiskIoSnapshot {
  meta: MetricMeta;
  devices: Array<{
    device: string;
    readBytesPerSec: number | null;
    writeBytesPerSec: number | null;
    readIops: number | null;
    writeIops: number | null;
  }>;
  /** Sum across physical devices (array + pools + boot excluded by filter). */
  totals: {
    readBytesPerSec: number | null;
    writeBytesPerSec: number | null;
  };
}

export interface StorageHistoryPayload {
  meta: MetricMeta;
  window: string;
  stepSeconds: number;
  read: NamedSeries[];
  write: NamedSeries[];
  readIops: NamedSeries[];
  writeIops: NamedSeries[];
  totals: {
    read: HistoryPoint[];
    write: HistoryPoint[];
  };
}

/* Diagnostics / version ------------------------------------------------------ */

export interface DataSourceStatus {
  unraid: {
    reachable: boolean;
    latencyMs: number | null;
    lastSuccessAt: string | null;
    targetHost: string | null;
  };
  prometheus: {
    configured: boolean;
    reachable: boolean;
    latencyMs: number | null;
    url: string | null;
    lastSuccessAt: string | null;
  };
}

export interface DiagnosticsPayload {
  version: BuildInfoDto;
  sources: DataSourceStatus;
  /** ISO timestamps of last successful fetch per server-side domain. */
  sections: Record<string, string | null>;
  generatedAt: string;
}

export interface BuildInfoDto {
  version: string;
  gitSha: string | null;
  buildTime: string | null;
  imageRef: string | null;
}

/* Overview additions ---------------------------------------------------------- */

export interface OverviewExtras {
  /** Prometheus availability for the whole payload. */
  prometheus: {
    configured: boolean;
    status: LiveStatus;
    reason?: string;
  };
  load: LoadInfo | null;
  /** 5-minute average host CPU% — sustained load, not a spike. */
  sustainedCpuPercent: number | null;
  /** Package temp + 1h peak, when Prometheus is available. */
  thermal: {
    packageC: number | null;
    /** 5-minute average package temp — sustained heat, not a spike. */
    package5mAvgC: number | null;
    peak1hC: number | null;
    hottestC: number | null;
    hottestName: string | null;
  } | null;
  /** Aggregate physical disk throughput. */
  diskIo: {
    readBytesPerSec: number | null;
    writeBytesPerSec: number | null;
  } | null;
  /** Primary interface name used for the RX/TX card. */
  primaryInterface: string | null;
  primaryRx: number | null;
  primaryTx: number | null;
  unhealthyContainers: number | null;
  highMemoryContainers: number | null;
  topConsumers: TopConsumers | null;
}

/* ==========================================================================
 * v0.4: access control, write actions, audit
 * ========================================================================== */

export interface AuthIdentity {
  mode: "disabled" | "proxy";
  /** Proxy-authenticated user name, when known. */
  user: string | null;
}

export interface AuthStatus {
  mode: "disabled" | "proxy";
  /** Signed-in identity (proxy mode), or null. */
  user: string | null;
  /** True when write actions are enabled and configured server-side. */
  actionsEnabled: boolean;
  /** Human reason when actions are disabled. */
  actionsDisabledReason: string | null;
}

/** Allowlisted lifecycle action types. */
export type ContainerActionType = "start" | "stop" | "restart";
export type VmActionType = "start" | "stop";

export interface ActionRequestBody {
  /** "docker" or "vm". */
  kind: "docker" | "vm";
  action: ContainerActionType | VmActionType;
  /** Exact target id from the live inventory (docker composite id / VM domain id). */
  id: string;
  /** Exact target name — verified against the live inventory before mutating. */
  name?: string;
}

export interface ActionResponseBody {
  ok: boolean;
  /** Action accepted and executed (state transition verified separately). */
  status:
    | "success"
    | "rejected"
    | "not-found"
    | "already-in-state"
    | "timeout"
    | "error";
  message?: string;
  /** Post-action state from the live inventory, when readable. */
  state?: string | null;
  /** Audit entry id for traceability. */
  auditId?: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  /** Authenticated user (proxy mode) or "local". */
  actor: string;
  /** Client IP as observed by the dashboard. */
  sourceIp: string;
  kind: "docker" | "vm" | "notification" | "dashboard" | "update";
  action: string;
  /** Target name (display) and id. */
  targetName: string;
  targetId: string;
  result: "success" | "failed" | "rejected" | "not-found" | "already-in-state" | "timeout";
  durationMs: number;
  /** Short error summary, no credential material ever. */
  error?: string;
}

export interface AuditLogPayload {
  entries: AuditEntry[];
  total: number;
  truncated: boolean;
}

/* ---- Shared dashboards (server-persisted layouts, v0.6) ------------------- */

export type OverviewWidgetId = "cpu" | "memory" | "uptime" | "array" | "network" | "docker";

/** Mirrors the server's versioned dashboard schema (validated there too). */
export interface SharedDashboardDto {
  schemaVersion: number;
  /** Opaque id, 12 lowercase alphanumerics. */
  id: string;
  name: string;
  /** Proxy identity or "lan" in trusted-LAN mode. */
  owner: string;
  layout: {
    order: OverviewWidgetId[];
    hidden: OverviewWidgetId[];
  };
  preferences: {
    historyWindow: "5m" | "15m" | "1h" | "6h" | "24h" | "7d";
    density: "compact" | "comfortable";
    tempUnit: "C" | "F";
    refresh: "fast" | "normal" | "relaxed";
    dockerMetrics: boolean;
    showPerCore: boolean;
    dockerFilter: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface DashboardListPayload {
  dashboards: SharedDashboardDto[];
  invalid: string[];
  identity: AuthIdentity;
}

export interface DashboardImportResult {
  imported: SharedDashboardDto[];
  rejected: Array<{ index: number; reason: string }>;
}


export interface ActionsCapabilities {
  enabled: boolean;
  /** Reason when disabled (missing key, flag off, …). */
  reason: string | null;
  docker: ContainerActionType[];
  vm: VmActionType[];
  notification: string[];
  cooldownMs: number;
  ratePerMinute: number;
}

export interface ContainerDetailPayload {
  /* eslint-disable-next-line -- dto */
  id: string;
  name: string;
  image: string;
  command: string | null;
  state: string;
  status: string;
  health: ContainerHealth;
  autoStart: boolean;
  updateAvailable: boolean;
  iconUrl: string | null;
  webUiUrl: string | null;
  createdEpochSeconds: number | null;
  composeProject: string | null;
  ports: { privatePort: number | null; publicPort: number | null; type: string | null }[];
  /** Parsed docker inspect mounts (safe subset). */
  mounts: Array<{ type: string | null; source: string | null; destination: string | null; rw: boolean | null }>;
  /** Parsed network settings (safe subset): per-network IP/gateway + mac. */
  networks: Array<{ name: string; ip: string | null; gateway: string | null; mac: string | null }>;
  /** Full label set (labels are not env secrets). */
  labels: Record<string, string>;
}
