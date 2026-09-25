"use client";

import { useEffect } from "react";
import { ArrowDownToLine, ArrowUpFromLine, Boxes, Cpu, Gauge, HardDrive, MemoryStick, Thermometer, X } from "lucide-react";
import Link from "next/link";
import { usePoll } from "@/hooks/use-poll";
import { PAGE_INTERVAL_MS } from "@/lib/prefs";
import { formatBytes, formatPercent, formatRate, formatTemp, formatUptime, humanState } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type {
  DockerSummary,
  OverviewPayload,
  Section,
  SystemMetricsSnapshot,
  TopConsumers,
} from "@/lib/api-types";

/**
 * NOC wallboard: fullscreen, dense, auto-refreshing, read-only.
 * No lifecycle controls exist here by design.
 */

function useFullscreen() {
  const enter = () => {
    void document.documentElement.requestFullscreen?.().catch(() => {});
  };
  const exit = () => {
    void document.exitFullscreen?.().catch(() => {});
  };
  return { enter, exit };
}

function Tile({
  label,
  value,
  sub,
  alert,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string | null;
  alert?: boolean;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
}) {
  return (
    <div
      className={cn(
        "rounded-lg border bg-card/60 p-4",
        alert && "border-destructive/60",
      )}
    >
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-wider text-muted-foreground">
        <Icon className="size-3.5" aria-hidden={true} />
        {label}
      </p>
      <p className={cn("mt-1 font-mono text-3xl font-semibold tabular-nums leading-none", alert && "text-destructive")}>
        {value}
      </p>
      {sub && <p className="mt-1 truncate text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

export default function NocPage() {
  const overview = usePoll<OverviewPayload>("/api/overview?window=15m", PAGE_INTERVAL_MS.overview);
  const snapshot = usePoll<{ meta: import("@/lib/api-types").MetricMeta; data: SystemMetricsSnapshot | null }>(
    "/api/system/metrics",
    PAGE_INTERVAL_MS.systemMetrics,
  );
  const docker = usePoll<Section<DockerSummary>>("/api/docker", PAGE_INTERVAL_MS.docker);
  const { enter } = useFullscreen();

  // Auto-hide cursor after inactivity (wallboard friendly).
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const show = () => {
      document.body.style.cursor = "";
      clearTimeout(timer);
      timer = setTimeout(() => {
        document.body.style.cursor = "none";
      }, 10_000);
    };
    show();
    window.addEventListener("mousemove", show);
    window.addEventListener("keydown", show);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousemove", show);
      window.removeEventListener("keydown", show);
      document.body.style.cursor = "";
    };
  }, []);

  const payload = overview.data;
  const extras = payload?.extras ?? null;
  const snap = snapshot.data?.data ?? null;
  const snapStatus = snapshot.data?.meta.status;
  const health = payload?.health;
  const topCpu = extras?.topConsumers?.cpu.slice(0, 5) ?? [];

  return (
    <div className="min-h-svh bg-background p-4 sm:p-6">
      {/* Header */}
      <div className="mb-4 flex items-center gap-3">
        <p
          role={health?.level === "critical" ? "alert" : "status"}
          className={cn(
            "flex items-center gap-2 text-sm font-semibold",
            health?.level === "critical"
              ? "text-destructive"
              : health?.level === "attention"
                ? "text-warning"
                : "text-success",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-3 rounded-full",
              health?.level === "critical"
                ? "animate-pulse bg-destructive"
                : health?.level === "attention"
                  ? "bg-warning"
                  : "bg-success",
            )}
          />
          {health?.level === "critical" ? "NEEDS ATTENTION" : health?.level === "attention" ? "WARNING" : "ALL SYSTEMS NOMINAL"}
        </p>
        {payload?.identity.data && (
          <span className="text-sm text-muted-foreground">
            {payload.identity.data.serverName} · up {formatUptime(payload.identity.data.uptimeSeconds)}
          </span>
        )}
        <Button variant="ghost" size="sm" asChild className="ml-auto" aria-label="Exit NOC mode">
          <Link href="/">
            <X className="size-4" aria-hidden={true} /> Exit
          </Link>
        </Button>
      </div>

      {health && health.reasons.length > 0 && (
        <p className={cn("mb-4 truncate text-sm", health.level === "critical" ? "text-destructive" : "text-warning")}>
          {health.reasons.join(" · ")}
        </p>
      )}

      {/* Main tiles */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
        <Tile
          label="CPU"
          icon={Cpu}
          value={formatPercent(snap?.cpuPercent ?? payload?.cpu.data?.percentTotal)}
          sub={
            extras?.load?.five !== null && extras?.load
              ? `load ${extras.load.five?.toFixed(2)} · ${extras.load.threads ?? "?"} threads`
              : null
          }
          alert={(snap?.cpuPercent ?? 0) >= 90}
        />
        <Tile
          label="RAM"
          icon={MemoryStick}
          value={formatPercent(payload?.memory.data?.percentTotal)}
          sub={payload?.memory.data ? `${formatBytes(payload.memory.data.usedBytes)} / ${formatBytes(payload.memory.data.totalBytes)}` : null}
          alert={(payload?.memory.data?.percentTotal ?? 0) >= 90}
        />
        <Tile
          label="Package"
          icon={Thermometer}
          value={snapStatus === "unavailable" ? "—" : formatTemp(snap?.thermal?.packageC ?? null, "C")}
          sub={snap?.thermal?.hottestName ? `hottest ${snap.thermal.hottestName}` : null}
          alert={(snap?.thermal?.packageC ?? 0) >= 90}
        />
        <Tile
          label="Array"
          icon={HardDrive}
          value={formatBytes(payload?.storage.data?.usedBytes)}
          sub={payload?.storage.data ? `${humanState(payload.storage.data.state)} · ${payload.storage.data.disks.length} disks` : null}
          alert={payload?.storage.data?.state !== "STARTED"}
        />
        <Tile
          label="Docker"
          icon={Boxes}
          value={docker.data?.data ? `${docker.data.data.running}/${docker.data.data.total}` : "—"}
          sub={extras?.unhealthyContainers ? `${extras.unhealthyContainers} unhealthy` : "all healthy"}
          alert={(extras?.unhealthyContainers ?? 0) > 0}
        />
        <Tile
          label="Net RX"
          icon={ArrowDownToLine}
          value={formatRate(extras?.primaryRx ?? payload?.network.data?.rxBytesPerSec)}
          sub={extras?.primaryInterface ?? null}
        />
        <Tile
          label="Net TX"
          icon={ArrowUpFromLine}
          value={formatRate(extras?.primaryTx ?? payload?.network.data?.txBytesPerSec)}
          sub={extras?.diskIo ? `disk ${formatRate(extras.diskIo.readBytesPerSec)} r` : null}
        />
        <Tile
          label="Load 5"
          icon={Gauge}
          value={extras?.load?.five !== null && extras?.load ? extras.load.five.toFixed(2) : "—"}
          sub={extras?.load?.level ? `level: ${extras.load.level}` : null}
        />
      </div>

      {/* Secondary row */}
      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border bg-card/60 p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Top CPU consumers</p>
          <ul className="mt-2 space-y-1.5">
            {topCpu.map((entry) => (
              <li key={entry.name} className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
                <span className="font-mono text-sm tabular-nums">{formatPercent(entry.percent)}</span>
                <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, entry.percent ?? 0)}%` }} />
                </div>
              </li>
            ))}
            {topCpu.length === 0 && <li className="text-sm text-muted-foreground">unavailable</li>}
          </ul>
        </div>
        <div className="rounded-lg border bg-card/60 p-4">
          <p className="text-xs uppercase tracking-wider text-muted-foreground">Disk throughput</p>
          {extras?.diskIo ? (
            <div className="mt-2 flex items-center gap-6">
              <p className="font-mono text-2xl tabular-nums">{formatRate(extras.diskIo.readBytesPerSec)}</p>
              <p className="text-xs text-muted-foreground">read</p>
              <p className="font-mono text-2xl tabular-nums">{formatRate(extras.diskIo.writeBytesPerSec)}</p>
              <p className="text-xs text-muted-foreground">write</p>
            </div>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">unavailable</p>
          )}
        </div>
      </div>

      <p className="mt-4 text-[11px] text-muted-foreground">
        NOC mode is read-only by design — no lifecycle controls are exposed here.
      </p>
    </div>
  );
}
