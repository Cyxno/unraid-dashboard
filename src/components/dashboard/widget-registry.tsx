"use client";

import { useMemo } from "react";
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  Bell,
  Boxes,
  ClipboardList,
  Cpu,
  Flame,
  Gauge,
  HardDrive,
  MemoryStick,
  Network,
  Thermometer,
} from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { PAGE_INTERVAL_MS } from "@/lib/prefs";
import { SIZE_SPAN, type WidgetEntry, type WidgetId } from "@/lib/widgets";
import { SectionStatus } from "./section-status";
import { Badge } from "@/components/ui/badge";
import { formatBytes, formatPercent, formatRate, formatTemp, formatUptime, humanState } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type {
  AuditLogPayload,
  DockerSummary,
  NetworkInterfaceInfo,
  NotificationsSummary,
  OverviewPayload,
  Section,
  StorageUsage,
  SystemMetricsSnapshot,
} from "@/lib/api-types";

/**
 * Shared-dashboard widget renderers (v0.7).
 *
 * One component per registry widget; each fetches only what it renders
 * via the standard poll hooks (server TTL caches make this cheap), so a
 * hidden widget never loads data. Used by /dashboard/<id>, the layout
 * editor preview and NOC wallboards.
 */

function WidgetFrame({
  title,
  icon: Icon,
  children,
  className,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border bg-card/60 p-4", className)}>
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5" aria-hidden={true} />
        {title}
      </p>
      {children}
    </div>
  );
}

function MiniStat({ label, value, alert }: { label: string; value: string; alert?: boolean }) {
  return (
    <div className="rounded-md border p-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn("font-mono text-xl font-semibold tabular-nums", alert && "text-destructive")}>{value}</p>
    </div>
  );
}

/* Individual widgets -------------------------------------------------------- */

export function HealthWidget({ overview }: { overview: OverviewPayload | null }) {
  const health = overview?.health;
  const identity = overview?.identity.data;
  const level = health?.level ?? "unknown";
  return (
    <WidgetFrame title="System" icon={Activity}>
      <p
        className={cn(
          "text-lg font-semibold",
          level === "critical" ? "text-destructive" : level === "attention" ? "text-warning" : "text-success",
        )}
      >
        {level === "critical" ? "Needs attention" : level === "attention" ? "Warning" : "All nominal"}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {identity ? `${identity.serverName} · Unraid v${identity.osVersion} · up ${formatUptime(identity.uptimeSeconds)}` : "—"}
      </p>
      {health && health.reasons.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
          {health.reasons.slice(0, 3).map((reason) => (
            <li key={reason} className="truncate">· {reason}</li>
          ))}
        </ul>
      )}
    </WidgetFrame>
  );
}

export function CpuWidget({ overview }: { overview: OverviewPayload | null }) {
  const cpu = overview?.cpu.data;
  const load = overview?.extras?.load ?? null;
  return (
    <WidgetFrame title="CPU" icon={Cpu}>
      <p className="font-mono text-3xl font-semibold tabular-nums">{formatPercent(cpu?.percentTotal)}</p>
      {load && (
        <p className="mt-1 text-xs text-muted-foreground">
          load {load.one?.toFixed(2) ?? "—"} / {load.five?.toFixed(2) ?? "—"} / {load.fifteen?.toFixed(2) ?? "—"}
          {load.threads !== null && ` · ${load.threads} threads`}
        </p>
      )}
    </WidgetFrame>
  );
}

export function MemoryWidget({ overview }: { overview: OverviewPayload | null }) {
  const memory = overview?.memory.data;
  const percent = memory && memory.totalBytes > 0 ? (memory.usedBytes / memory.totalBytes) * 100 : null;
  return (
    <WidgetFrame title="Memory" icon={MemoryStick}>
      <p className="font-mono text-3xl font-semibold tabular-nums">{formatPercent(percent)}</p>
      <p className="mt-1 text-xs text-muted-foreground">
        {formatBytes(memory?.usedBytes)} of {formatBytes(memory?.totalBytes)}
      </p>
    </WidgetFrame>
  );
}

export function ThermalWidget({
  tempUnit,
  compact,
}: {
  tempUnit: "C" | "F";
  compact?: boolean;
}) {
  const snapshot = usePoll<{ meta: { status: string }; data: SystemMetricsSnapshot | null }>(
    "/api/system/metrics",
    PAGE_INTERVAL_MS.systemMetrics,
  );
  const thermal = snapshot.data?.data?.thermal ?? null;
  return (
    <WidgetFrame title="Thermal" icon={Thermometer}>
      <p className={cn("font-mono font-semibold tabular-nums", compact ? "text-3xl" : "text-3xl", (thermal?.packageC ?? 0) >= 90 && "text-destructive")}>
        {formatTemp(thermal?.packageC ?? null, tempUnit)}
      </p>
      <p className="mt-1 truncate text-xs text-muted-foreground">
        {thermal?.hottestName ? `hottest: ${thermal.hottestName}` : "package temperature"}
      </p>
    </WidgetFrame>
  );
}

export function StorageWidget({ overview }: { overview: OverviewPayload | null }) {
  const storage = usePoll<Section<StorageUsage>>("/api/storage", PAGE_INTERVAL_MS.storage);
  const data = storage.data?.data ?? overview?.storage.data ?? null;
  const percent = data && data.totalBytes > 0 ? (data.usedBytes / data.totalBytes) * 100 : null;
  return (
    <WidgetFrame title="Array & storage" icon={HardDrive}>
      <div className="flex items-baseline gap-2">
        <p className="font-mono text-2xl font-semibold tabular-nums">{formatBytes(data?.usedBytes)}</p>
        <p className="text-xs text-muted-foreground">of {formatBytes(data?.totalBytes)}</p>
      </div>
      {percent !== null && (
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, percent)}%` }} />
        </div>
      )}
      <p className="mt-1.5 text-xs text-muted-foreground">
        {data ? `${humanState(data.state)} · ${data.disks.length} disks` : "—"}
      </p>
    </WidgetFrame>
  );
}

export function DockerWidget({ overview, filter }: { overview: OverviewPayload | null; filter?: string }) {
  const docker = usePoll<Section<DockerSummary>>("/api/docker", PAGE_INTERVAL_MS.docker);
  const data = docker.data?.data ?? overview?.docker.data ?? null;
  const needle = filter?.trim().toLowerCase() ?? "";
  const containers = useMemo(() => {
    const list = data?.containers ?? [];
    if (!needle) return list;
    return list.filter(
      (container) =>
        container.name.toLowerCase().includes(needle) ||
        container.image.toLowerCase().includes(needle),
    );
  }, [data, needle]);

  return (
    <WidgetFrame title={`Docker${needle ? ` — filter: ${filter}` : ""}`} icon={Boxes}>
      {data && (
        <div className="mb-2 flex items-center gap-2">
          <Badge variant="muted">{data.running}/{data.total} running</Badge>
          <SectionStatus section={docker.data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }} compact />
        </div>
      )}
      <ul className="grid gap-1 sm:grid-cols-2">
        {containers.slice(0, 8).map((container) => (
          <li
            key={container.id}
            className={cn(
              "flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs",
              container.state !== "RUNNING" && "opacity-60",
              container.health === "unhealthy" && "border-destructive/60",
            )}
          >
            <span className="min-w-0 truncate">{container.name}</span>
            <span className={cn("shrink-0", container.state === "RUNNING" ? "text-success" : "text-muted-foreground")}>
              {container.state === "RUNNING" ? "up" : container.state.toLowerCase()}
            </span>
          </li>
        ))}
        {containers.length > 8 && (
          <li className="text-[11px] text-muted-foreground">+ {containers.length - 8} more</li>
        )}
        {containers.length === 0 && <li className="text-xs text-muted-foreground">No containers.</li>}
      </ul>
    </WidgetFrame>
  );
}

export function TopCpuWidget({ overview }: { overview: OverviewPayload | null }) {
  const top = overview?.extras?.topConsumers?.cpu.slice(0, 5) ?? [];
  return (
    <WidgetFrame title="Top CPU containers" icon={Gauge}>
      <ul className="space-y-1.5">
        {top.map((entry) => (
          <li key={entry.name} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="font-mono tabular-nums">{formatPercent(entry.percent)}</span>
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, entry.percent ?? 0)}%` }} />
            </div>
          </li>
        ))}
        {top.length === 0 && <li className="text-xs text-muted-foreground">unavailable</li>}
      </ul>
    </WidgetFrame>
  );
}

export function TopMemoryWidget({ overview }: { overview: OverviewPayload | null }) {
  const top = overview?.extras?.topConsumers?.memory.slice(0, 5) ?? [];
  return (
    <WidgetFrame title="Top memory containers" icon={MemoryStick}>
      <ul className="space-y-1.5">
        {top.map((entry) => (
          <li key={entry.name} className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="font-mono tabular-nums">{formatBytes(entry.bytes)}</span>
          </li>
        ))}
        {top.length === 0 && <li className="text-xs text-muted-foreground">unavailable</li>}
      </ul>
    </WidgetFrame>
  );
}

export function NetworkWidget({ interfaceName, overview }: { interfaceName?: string; overview: OverviewPayload | null }) {
  const network = usePoll<Section<NetworkInterfaceInfo[]>>("/api/network", PAGE_INTERVAL_MS.network);
  const extras = overview?.extras ?? null;
  const interfaces = network.data?.data ?? [];
  const selected = interfaceName
    ? interfaces.find((entry) => entry.name === interfaceName) ?? null
    : null;
  return (
    <WidgetFrame title={`Network${interfaceName ? ` · ${interfaceName}` : ""}`} icon={Network}>
      <div className="grid grid-cols-2 gap-2">
        <MiniStat label="RX" value={formatRate(extras?.primaryRx)} />
        <MiniStat label="TX" value={formatRate(extras?.primaryTx)} />
      </div>
      <p className="mt-1.5 truncate text-xs text-muted-foreground">
        {selected
          ? `${selected.name} · ${selected.ipAddress ?? "no ip"} · ${selected.speedMbps ? `${selected.speedMbps} Mb/s` : "speed n/a"}`
          : extras?.primaryInterface
            ? `primary: ${extras.primaryInterface}`
            : "—"}
      </p>
    </WidgetFrame>
  );
}

export function DiskIoWidget({ overview }: { overview: OverviewPayload | null }) {
  const diskIo = overview?.extras?.diskIo ?? null;
  return (
    <WidgetFrame title="Disk I/O" icon={ArrowDownToLine}>
      <div className="grid grid-cols-2 gap-2">
        <MiniStat label="Read" value={formatRate(diskIo?.readBytesPerSec)} />
        <MiniStat label="Write" value={formatRate(diskIo?.writeBytesPerSec)} />
      </div>
      <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
        <ArrowUpFromLine className="size-3" aria-hidden="true" /> aggregate physical devices
      </p>
    </WidgetFrame>
  );
}

export function NotificationsWidget() {
  const notifications = usePoll<Section<NotificationsSummary>>("/api/notifications", PAGE_INTERVAL_MS.notifications);
  const unread = notifications.data?.data?.unreadCounts;
  return (
    <WidgetFrame title="Notifications" icon={Bell}>
      <div className="grid grid-cols-3 gap-2">
        <MiniStat label="Info" value={String(unread?.info ?? 0)} />
        <MiniStat label="Warnings" value={String(unread?.warning ?? 0)} alert={(unread?.warning ?? 0) > 0} />
        <MiniStat label="Alerts" value={String(unread?.alert ?? 0)} alert={(unread?.alert ?? 0) > 0} />
      </div>
    </WidgetFrame>
  );
}

export function AuditWidget() {
  const audit = usePoll<AuditLogPayload>("/api/audit?limit=8", PAGE_INTERVAL_MS.connection);
  const entries = audit.data?.entries ?? [];
  return (
    <WidgetFrame title="Recent audit events" icon={ClipboardList}>
      <ul className="space-y-1 text-xs">
        {entries.slice(0, 6).map((entry) => (
          <li key={entry.id} className="flex items-center gap-2">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                entry.result === "success" ? "bg-success" : "bg-destructive",
              )}
              aria-hidden="true"
            />
            <span className="min-w-0 flex-1 truncate">
              {entry.kind}/{entry.action} · {entry.targetName}
            </span>
            <span className="shrink-0 text-muted-foreground">{entry.actor}</span>
          </li>
        ))}
        {entries.length === 0 && <li className="text-muted-foreground">No audit entries yet.</li>}
      </ul>
    </WidgetFrame>
  );
}

/* Registry dispatch --------------------------------------------------------- */

export function WidgetRenderer({
  widget,
  overview,
  preferences,
  compact,
}: {
  widget: WidgetEntry;
  overview: OverviewPayload | null;
  preferences: { tempUnit: "C" | "F"; dockerFilter: string; networkInterface: string };
  compact?: boolean;
}) {
  switch (widget.id) {
    case "health":
      return <HealthWidget overview={overview} />;
    case "cpu":
      return <CpuWidget overview={overview} />;
    case "memory":
      return <MemoryWidget overview={overview} />;
    case "thermal":
      return <ThermalWidget tempUnit={preferences.tempUnit} compact={compact} />;
    case "storage":
      return <StorageWidget overview={overview} />;
    case "docker":
      return <DockerWidget overview={overview} filter={preferences.dockerFilter} />;
    case "top-cpu":
      return <TopCpuWidget overview={overview} />;
    case "top-memory":
      return <TopMemoryWidget overview={overview} />;
    case "network":
      return <NetworkWidget interfaceName={preferences.networkInterface || undefined} overview={overview} />;
    case "disk-io":
      return <DiskIoWidget overview={overview} />;
    case "notifications":
      return <NotificationsWidget />;
    case "audit":
      return <AuditWidget />;
    default:
      return null;
  }
}

/** Widget grid: spans per size, mobile-first single column. */
export function WidgetGrid({
  widgets,
  overview,
  preferences,
  compact,
}: {
  widgets: WidgetEntry[];
  overview: OverviewPayload | null;
  preferences: { tempUnit: "C" | "F"; dockerFilter: string; networkInterface: string };
  compact?: boolean;
}) {
  return (
    <div className={cn("grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3", compact && "gap-2")}>
      {widgets.map((widget) => (
        <div key={widget.id} className={cn(SIZE_SPAN[widget.size], "min-w-0")}>
          <WidgetRenderer widget={widget} overview={overview} preferences={preferences} compact={compact} />
        </div>
      ))}
    </div>
  );
}

/** Editor preview uses the same grid; Flame import kept for thermal icon use. */
export const WIDGET_ICONS: Record<WidgetId, React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>> = {
  health: Activity,
  cpu: Cpu,
  memory: MemoryStick,
  thermal: Flame,
  storage: HardDrive,
  docker: Boxes,
  "top-cpu": Gauge,
  "top-memory": MemoryStick,
  network: Network,
  "disk-io": ArrowDownToLine,
  notifications: Bell,
  audit: ClipboardList,
};
