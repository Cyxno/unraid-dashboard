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
  /** Canonical: totalBytes − usedBytes when the source exposes it (v0.9.7). */
  availableBytes: number | null;
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
  /** v1.5.0: canonical per-source health + self-observability confidence. */
  sourceHealth?: SourceHealth[];
  confidence?: ObservabilityConfidence;
  persistence?: {
    dataDirWritable: boolean | null;
    lastSuccessfulPersistAt: string | null;
    incidentsStateBytes: number | null;
  };
  /** ISO timestamps of last successful fetch per server-side domain. */
  sections: Record<string, string | null>;
  /** v0.6 self-monitoring + persistence health (server-side). */
  self: {
    /** Dashboard process CPU% since the previous diagnostics call. */
    cpuPercent: number | null;
    memoryRssBytes: number | null;
    uptimeSeconds: number | null;
    sseSubscribers: number;
    sseSamplerRunning: boolean;
    audit: { fileBytes: number | null; writable: boolean };
    dashboards: { count: number; writable: boolean; invalidFiles: string[] };
    /** Overall /app/data verdict: audit + dashboards writable. */
    dataVolumeWritable: boolean;
    /** v0.7 additions. */
    authMode: "disabled" | "proxy" | "local";
    dashboardSchemaVersion: number;
    dataVolumeFreeBytes: number | null;
    helper: {
      configured: boolean;
      reachable: boolean | null;
      phase: string | null;
      helperVersion: string | null;
    };
    runningImageId: string | null;
    ghcrDigest: string | null;
    /** v0.9.4: read-only machine API counters (no credentials). */
    agentApi: {
      enabled: boolean;
      requests: number;
      authFailures: number;
      rateLimitHits: number;
      sseClients: number;
      lastRequestAt: string | null;
      lastRequestEndpoint: string | null;
    };
  };
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
  kind: "docker" | "vm" | "notification" | "dashboard" | "update" | "recovery" | "remediation";
  action: string;
  /** Target name (display) and id. */
  targetName: string;
  targetId: string;
  result: "success" | "failed" | "rejected" | "not-found" | "already-in-state" | "timeout";
  durationMs: number;
  /** Short error summary, no credential material ever. */
  error?: string;
  /** v1.7.0 remediation traceability (bounded, safe metadata only). */
  incidentId?: string;
  operationId?: string;
  traceId?: string;
}

export interface AuditLogPayload {
  entries: AuditEntry[];
  total: number;
  truncated: boolean;
}

/* ---- Shared dashboards (server-persisted layouts, v0.6+) ------------------ */

export type { WidgetId } from "@/lib/widgets";
import type { WidgetId } from "@/lib/widgets";

export type DashboardAccessMode = "private" | "shared-readonly" | "shared-editable";

export interface DashboardAccess {
  mode: DashboardAccessMode;
  /** Additional identities allowed to edit (shared-editable only). */
  editors: string[];
  /** Identities allowed to view a private dashboard. */
  viewers: string[];
}

/** Mirrors the server's versioned dashboard schema (validated there too). */
export interface SharedDashboardDto {
  schemaVersion: number;
  /** Opaque id, 12 lowercase alphanumerics. */
  id: string;
  name: string;
  /** Proxy identity or "lan" in trusted-LAN mode. */
  owner: string;
  /** Permission model (v0.7.3). */
  access: DashboardAccess;
  /** Widget layout: registry ids with predefined sizes (v2). */
  widgets: Array<{ id: WidgetId; size: "sm" | "md" | "lg" }>;
  preferences: {
    historyWindow: "5m" | "15m" | "1h" | "6h" | "24h" | "7d";
    density: "compact" | "comfortable";
    tempUnit: "C" | "F";
    refresh: "fast" | "normal" | "relaxed";
    dockerMetrics: boolean;
    showPerCore: boolean;
    dockerFilter: string;
    networkInterface: string;
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

/* ==========================================================================
 * v1.5.0: Incident Intelligence & Self-Diagnostics
 *
 * One canonical model for source health, freshness, evidence and
 * incidents. Every warning/critical the UI or notifications express must
 * be traceable to an incident carrying evidence (what proved it), a
 * source (who observed it), freshness (how old the data is) and impact
 * (what is degraded as a consequence). A source outage produces ONE root
 * incident with impact entries — never a cascade of per-entity problems.
 * ========================================================================== */

/** Canonical signal-source identifiers (Fase 1 matrix). */
export type SourceId =
  | "unraid-api"
  | "prometheus"
  | "cadvisor"
  | "node-exporter"
  | "helper"
  | "docker-inventory"
  | "web-push"
  | "persistence"
  | "beacon-update";

/** Canonical freshness classification (Fase 3) — the ONLY staleness
 *  vocabulary in the codebase; ad-hoc Date.now() comparisons are
 *  forbidden outside freshness.ts. */
export type Freshness = "fresh" | "aging" | "stale" | "unknown";

/** Source health contract (Fase 2). */
export type SourceHealthStatus = "healthy" | "degraded" | "stale" | "unavailable";

export interface SourceHealth {
  source: SourceId;
  status: SourceHealthStatus;
  /** ISO timestamp of the last successful observation. */
  lastSuccessAt: string | null;
  /** ISO timestamp of the last attempt (success or failure). */
  lastAttemptAt: string | null;
  /** Age of the last successful data in ms (null = never succeeded). */
  ageMs: number | null;
  /** Expected observation interval for freshness classification. */
  expectedIntervalMs: number | null;
  /** Last observed request latency in ms. */
  latencyMs: number | null;
  /** Sanitized error of the last failed attempt (no credentials/URLs). */
  safeError: string | null;
  freshness: Freshness;
  /** Short human detail, e.g. affected domains. */
  detail: string | null;
}

/** Evidence model (Fase 4). `evidenceType` guards causality language:
 *  only `direct` may state cause; `correlated` reads "correlated with". */
export type EvidenceType = "direct" | "derived" | "correlated" | "unknown";

export interface Evidence {
  /** What the evidence is about: container name, "array", disk, "host". */
  entity: string;
  /** Signal name, e.g. "docker.health", "disk.temperatureC". */
  signal: string;
  source: SourceId;
  /** ISO timestamp when the value was observed. */
  observedAt: string;
  freshness: Freshness;
  /** Human-readable bounded value, e.g. "health=unhealthy". */
  value: string;
  /** Rule/threshold id that classified this evidence, when derived. */
  rule?: string | null;
  evidenceType: EvidenceType;
}

export type IncidentSeverity = "critical" | "warning" | "info";
export type IncidentStatus = "active" | "recovered";

export type IncidentKind =
  | "source-unavailable"
  | "source-degraded"
  | "docker-unhealthy"
  | "crash-loop"
  | "flapping"
  | "array-state"
  | "disk-state"
  | "disk-thermal"
  | "thermal"
  | "memory-pressure"
  | "cpu-sustained"
  | "notification-backlog"
  | "update-failed"
  | "persistence-failure";

export interface TimelineEvent {
  at: string;
  /** Compact factual event line, e.g. "became unhealthy". */
  event: string;
  detail?: string | null;
}

/** Delivery observability (Fase 27): only technically proven facts.
 *  Push = provider accepted; in-app = delivered to open SSE clients.
 *  Never claims "device displayed". */
export interface IncidentDelivery {
  /** "provider-accepted" | "failed" | "not-configured" | "no-devices" | null */
  push: string | null;
  /** "delivered" | "no-subscribers" | null */
  inApp: string | null;
  at: string | null;
}

export interface Incident {
  /** Stable fingerprint — dedupe identity across polls and restarts. */
  id: string;
  entity: string;
  kind: IncidentKind;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  firstSeenAt: string;
  lastSeenAt: string;
  /** lastSeenAt − firstSeenAt while active; final duration when recovered. */
  durationMs: number;
  /** Primary source that proves this incident. */
  source: SourceId;
  evidence: Evidence[];
  /** Root incident this one is a consequence of (cascade grouping). */
  rootCauseId: string | null;
  /** Capabilities degraded by (or suppressed under) this incident. */
  impact: string[];
  notifiedAt: string | null;
  resolvedAt: string | null;
  /** Health-toggle pattern detected (one incident, no push storm). */
  flapping: boolean;
  /** Problems = actionable: false for neutral states and backlog info. */
  actionable: boolean;
  timeline: TimelineEvent[];
  /** Safe, non-destructive next check suggestion. */
  safeCheck: string | null;
  delivery: IncidentDelivery | null;
}

/** Derived overall health (replaces the old heuristic `deriveHealth`):
 *  the verdict is a pure function of active incidents. */
export interface HealthSummary {
  level: "healthy" | "attention" | "critical" | null;
  reasons: string[];
  /** v1.5.0: active incident counts by severity (Overview hierarchy). */
  counts?: { critical: number; warning: number; info: number };
}

export interface IncidentsPayload {
  active: Incident[];
  /** Bounded recently-recovered history (newest first). */
  recovered: Incident[];
  counts: { critical: number; warning: number; info: number; active: number };
  /** Overall verdict derived from the active incidents. */
  health: HealthSummary;
  /** Per-source health snapshot backing these incidents (Fase 2). */
  sources: SourceHealth[];
  /** Health of health (Fase 24): is Beacon's own observability trusted? */
  confidence: ObservabilityConfidence;
  evaluatedAt: string;
}

export interface ObservabilityConfidence {
  /** Overall: "full" | "degraded" | "blind". */
  level: "full" | "degraded" | "blind";
  reasons: string[];
}

/** Docker healthcheck explainability (Fase 9), served by the helper
 *  inventory (bounded, sanitized — never env/secrets). */
export interface ContainerHealthDetail {
  status: string | null;
  failingStreak: number | null;
  lastExitCode: number | null;
  /** Last healthcheck output, sanitized + hard-capped. */
  lastOutput: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
}

export interface SupportBundlePayload {
  generatedAt: string;
  version: BuildInfoDto;
  sourceHealth: SourceHealth[];
  confidence: ObservabilityConfidence;
  incidents: { active: number; critical: number; warning: number; info: number };
  activeIncidents: Array<Pick<Incident, "id" | "entity" | "kind" | "severity" | "firstSeenAt" | "lastSeenAt" | "title">>;
  persistence: {
    dataDirWritable: boolean | null;
    lastSuccessfulPersistAt: string | null;
    incidentsFileBytes: number | null;
    notificationsFileBytes: number | null;
  };
  inventoryDiagnostics: Record<string, unknown> | null;
  recentSafeErrors: string[];
  counts: { sources: number; activeIncidents: number };
  /** v1.7.0: safe remediation operation metadata (ids, states, verified
   *  outcomes) — never tokens, env secrets, auth or push details. */
  remediationOperations?: Array<Pick<OperationRecord, "id" | "entity" | "operation" | "state" | "startedAt"> & { message: string | null }>;
}

/* ==========================================================================
 * v1.6.0: Operational Intelligence & Capacity Forecasting
 *
 * Insights are NOT incidents: they are evidence-based observations about
 * slow degradation, capacity, recurrence and performance, each carrying a
 * confidence label and time window. Deterministic statistics only — no
 * ML/AI, no cloud, no destructive remediation. Forecasts are ranges with
 * explicit confidence, never exact alarmist dates.
 * ========================================================================== */

export type InsightType =
  | "capacity"
  | "trend"
  | "recurrence"
  | "degradation"
  | "performance"
  | "efficiency";

export type InsightSeverity = "info" | "watch" | "warning";

export type Confidence = "high" | "medium" | "low" | "insufficient";

export type TrendRange = "24h" | "7d" | "30d";

export type DataQuality = "good" | "partial" | "stale" | "missing";

/** A bounded aggregate point in the internal trend layer (Fase 1). */
export interface TrendSample {
  /** Bucket start (ISO). */
  t: string;
  value: number | null;
  quality: DataQuality;
}

/** Deterministic linear-trend result over a series (Fase 2/3). */
export interface TrendResult {
  /** Sign-consistent direction: rising | falling | flat | unknown. */
  direction: "rising" | "falling" | "flat" | "unknown";
  /** Per-day change in the metric's own unit (negative = falling). */
  slopePerDay: number | null;
  /** 0..1 coefficient of determination of the fit. */
  fit: number | null;
  sampleCount: number;
  coverage: number;
  quality: DataQuality;
  confidence: Confidence;
}

export interface CapacityForecast {
  entity: string;
  /** Human label, e.g. "Cache pool". */
  label: string;
  metric: "storage-usage-percent";
  current: number | null;
  /** Per-day growth in percentage points. */
  growthPerDay: number | null;
  growthPerWeek: number | null;
  window: TrendRange;
  /** Percentage threshold the trend is projected against. */
  projectedThreshold: number;
  /** Conservative RANGE (not an exact date), ISO timestamps; null when
   *  the trend is flat/noisy/insufficient — never an alarmist estimate. */
  projectedThresholdFrom: string | null;
  projectedThresholdTo: string | null;
  /** Human summary, e.g. "90% in ~2–4 weeks" or "trend unavailable". */
  summary: string;
  confidence: Confidence;
  sampleCount: number;
  dataQuality: DataQuality;
  recommendation: string | null;
}

export interface InsightEvidence {
  signal: string;
  value: string;
  source: string;
  window: TrendRange;
  quality: DataQuality;
}

export interface Insight {
  /** Stable fingerprint — one logical observation, never per-refresh. */
  id: string;
  entity: string;
  type: InsightType;
  severity: InsightSeverity;
  title: string;
  summary: string;
  evidence: InsightEvidence[];
  window: TrendRange;
  confidence: Confidence;
  firstObserved: string;
  lastObserved: string;
  actionable: boolean;
  deepLink: string;
  /** Safe, non-destructive suggestion (Fase 24), when applicable. */
  recommendation: string | null;
}

export interface SourcePerformanceEntry {
  source: string;
  sampleCount: number;
  p50Ms: number | null;
  p95Ms: number | null;
  window: TrendRange;
  confidence: Confidence;
}

export interface RecurrenceSummary {
  entity: string;
  kind: string;
  occurrences24h: number;
  occurrences7d: number;
  totalActiveDurationMs: number;
  meanDurationMs: number | null;
  longestDurationMs: number | null;
  lastOccurrence: string | null;
  recurring: boolean;
}

export interface MemoryCreepInsight {
  entity: string;
  startBytes: number | null;
  currentBytes: number | null;
  deltaBytes: number | null;
  slopeBytesPerHour: number | null;
  window: TrendRange;
  confidence: Confidence;
  summary: string;
}

export interface InsightsPayload {
  generatedAt: string;
  /** WATCH SOON + TRENDS + CAPACITY + RECURRING + PERFORMANCE sections. */
  sections: {
    watchSoon: Insight[];
    trends: Insight[];
    capacity: Insight[];
    recurring: Insight[];
    performance: Insight[];
  };
  forecasts: CapacityForecast[];
  memoryCreep: MemoryCreepInsight[];
  sourcePerformance: SourcePerformanceEntry[];
  recurrence: RecurrenceSummary[];
  /** Capability honesty: which ranges have enough history at all. */
  ranges: Array<{ range: TrendRange; available: boolean; reason: string | null }>;
}

export interface EntityHistoryPayload {
  entity: string;
  window: TrendRange;
  cpuTrend: TrendSample[];
  memoryTrend: TrendSample[];
  restarts: Array<{ at: string; correlated: string | null }>;
  incidents: Array<{ id: string; title: string; firstSeenAt: string; resolvedAt: string | null }>;
  insights: Insight[];
  forecast: CapacityForecast | null;
  growth: { perDayPercent: number | null; perWeekPercent: number | null } | null;
}

/* ==========================================================================
 * v1.7.0: Safe Remediation & Operational Runbooks
 *
 * Beacon helps operators decide what is safe to do now, what needs
 * confirmation, what must stay manual, what the expected effect is and
 * how recovery is proven afterwards. There is NO autonomous destructive
 * remediation, NO shell execution from the browser, NO AI/LLM in the
 * remediation path: every action below is a fixed, deterministic step
 * over the existing guarded pipelines.
 * ========================================================================== */

/** Risk classes: safe = read-only diagnostics; guarded = existing
 *  confirmed mutation; manual-only = operator must do it themselves. */
export type RemediationRisk = "safe" | "guarded" | "manual-only";

/** The only remediation step types that exist. The executor is a fixed
 *  switch over these — nothing free-form can ever run. */
export type RemediationActionType =
  | "refresh-incident-evidence"
  | "re-run-persistence-probe"
  | "re-check-registry"
  | "re-probe-push-delivery"
  | "docker-start"
  | "docker-stop"
  | "verified-update-retry";

export interface RemediationAction {
  /** Stable id, e.g. "diagnostic:refresh-evidence" or "docker:start". */
  id: string;
  incidentId: string | null;
  entity: string;
  type: RemediationActionType;
  title: string;
  description: string;
  risk: RemediationRisk;
  requiresConfirmation: boolean;
  /** Privilege the server side needs: none (own state), actions (Unraid
   *  action key) or helper (update helper token). */
  requiresPrivilege: "none" | "actions" | "helper";
  reversible: boolean;
  /** Precondition labels — re-checked on the server just before running. */
  preconditions: string[];
  /** How success is proven after the action (never just HTTP 200). */
  verification: string[];
  /** Bounded cooldown applied per entity+action (ms). */
  cooldownMs: number;
}

/** Explicit lifecycle: a green check requires OBSERVED state, never just
 *  an accepted request. */
export type OperationState =
  | "pending"
  | "executing"
  | "verifying"
  | "succeeded"
  | "failed"
  | "timed-out"
  | "rolled-back"
  | "cancelled";

export interface OperationRecord {
  id: string;
  entity: string;
  operation: RemediationActionType;
  incidentId: string | null;
  actor: string;
  state: OperationState;
  startedAt: string;
  updatedAt: string;
  /** Wall-clock bound; a timeout triggers a state re-read, never a
   *  conclusion about the system. */
  timeoutAt: string | null;
  traceId: string | null;
  message: string | null;
  timeline: TimelineEvent[];
}

export interface RunbookStep {
  title: string;
  detail: string;
}

/** Deterministic runbook for an incident kind. All text is fixed; no
 *  generated/free-form content is ever shown. */
export interface Runbook {
  scope: string;
  explanation: string;
  prerequisites: string[];
  diagnosticChecks: RunbookStep[];
  /** RemediationAction ids offered for this incident (safe + guarded). */
  actionIds: string[];
  verification: RunbookStep[];
  /** Operator-performed recovery steps (guidance only, no secrets, no
   *  dangerous one-liners). */
  manualRecovery: string[];
  escalation: string;
}

/** Incident detail payload extension (v1.7.0): runbook + offered actions
 *  + recent operations for this incident's entity. */
export interface IncidentDetailPayload {
  incident: Incident;
  source: SourceHealth | null;
  confidence: ObservabilityConfidence;
  runbook: Runbook | null;
  actions: RemediationAction[];
  operations: OperationRecord[];
  /** Demo substitution active: runbooks are shown, mutations refused. */
  demoActive?: boolean;
}

/** Payload for POST /api/remediation/action. */
export interface RemediationResult {
  ok: boolean;
  /** Operation state after the synchronous part of the action. */
  state: OperationState | "rejected" | "blocked";
  message: string;
  operation: OperationRecord | null;
  /** Diagnostic result detail (safe actions). */
  detail?: string;
  duplicate?: boolean;
  preconditionResults?: Array<{ id: string; ok: boolean; detail: string }>;
}
