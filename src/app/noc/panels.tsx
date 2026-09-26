"use client";

import { Boxes, Thermometer, HardDrive, Network } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { PAGE_INTERVAL_MS } from "@/lib/prefs";
import { formatBytes, formatRate, formatTemp, humanState } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type {
  DockerSummary,
  NetworkInterfaceInfo,
  OverviewPayload,
  Section,
  StorageUsage,
} from "@/lib/api-types";

/**
 * NOC auto-cycle panels: compact, wallboard-readable renderings of each
 * domain. All read-only; all reuse the standard polling hooks so cycle
 * panels stay live like the rest of the app.
 */

export type CyclePanelId = "overview" | "docker" | "thermal" | "storage" | "network";

export const CYCLE_PANELS: Array<{ id: CyclePanelId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "docker", label: "Docker" },
  { id: "thermal", label: "Thermal" },
  { id: "storage", label: "Storage" },
  { id: "network", label: "Network" },
];

function PanelShell({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-card/60 p-4">
      <p className="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="size-4" aria-hidden={true} />
        {title}
      </p>
      {children}
    </div>
  );
}

/** Container list rows without any controls (wallboard-safe). */
function DockerRows({ docker }: { docker: Section<DockerSummary> | null }) {
  const containers = docker?.data?.containers ?? [];
  const shown = containers.slice(0, 12);
  return (
    <ul className="grid gap-1 sm:grid-cols-2 xl:grid-cols-3">
      {shown.map((container) => (
        <li
          key={container.id}
          className={cn(
            "flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-sm",
            container.state !== "RUNNING" && "opacity-60",
            container.health === "unhealthy" && "border-destructive/60",
          )}
        >
          <span className="min-w-0 truncate">{container.name}</span>
          <span
            className={cn(
              "shrink-0 text-[11px] font-medium",
              container.state === "RUNNING" ? "text-success" : "text-muted-foreground",
            )}
          >
            {container.state === "RUNNING" ? "up" : container.state.toLowerCase()}
            {container.health === "unhealthy" && " · unhealthy"}
          </span>
        </li>
      ))}
      {containers.length > 12 && (
        <li className="text-xs text-muted-foreground">+ {containers.length - 12} more</li>
      )}
      {containers.length === 0 && <li className="text-sm text-muted-foreground">No containers.</li>}
    </ul>
  );
}

/** One auto-cycled NOC panel (fetches its own data, cheaply cached server-side). */
export function CyclePanel({ panel, overview }: { panel: CyclePanelId; overview: OverviewPayload | null }) {
  const docker = usePoll<Section<DockerSummary>>("/api/docker", PAGE_INTERVAL_MS.docker);
  const systemMetrics = usePoll<{ meta: { status: string }; data: { thermal?: { packageC: number | null; hottestName: string | null }; cpuPercent?: number | null } | null }>(
    "/api/system/metrics",
    PAGE_INTERVAL_MS.systemMetrics,
  );
  const storage = usePoll<Section<StorageUsage>>("/api/storage", PAGE_INTERVAL_MS.storage);
  const network = usePoll<Section<NetworkInterfaceInfo[]>>("/api/network", PAGE_INTERVAL_MS.network);

  const temp = systemMetrics.data?.data?.thermal?.packageC ?? overview?.extras?.thermal?.packageC ?? null;

  if (panel === "docker") {
    return (
      <PanelShell title={`Docker — ${docker.data?.data ? `${docker.data.data.running}/${docker.data.data.total} running` : "…"}`} icon={Boxes}>
        <DockerRows docker={docker.data} />
      </PanelShell>
    );
  }

  if (panel === "thermal") {
    const hottest = systemMetrics.data?.data?.thermal?.hottestName ?? overview?.extras?.thermal?.hottestName ?? null;
    const thermal = overview?.extras?.thermal ?? null;
    return (
      <PanelShell title="Thermal" icon={Thermometer}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Package</p>
            <p className={cn("font-mono text-3xl tabular-nums", (temp ?? 0) >= 90 && "text-destructive")}>
              {formatTemp(temp, "C")}
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">1h peak</p>
            <p className="font-mono text-3xl tabular-nums">{formatTemp(thermal?.peak1hC ?? null, "C")}</p>
          </div>
          <div className="col-span-2 rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Hottest sensor</p>
            <p className="truncate text-lg">{hottest ?? "—"}</p>
            {overview?.extras?.thermal?.packageC != null && (
              <p className="text-xs text-muted-foreground">current {formatTemp(overview.extras.thermal.packageC, "C")}</p>
            )}
          </div>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Full analysis on System → Temps (buckets, episodes, correlation).
        </p>
      </PanelShell>
    );
  }

  if (panel === "storage") {
    const data = storage.data?.data ?? overview?.storage.data ?? null;
    const percent = data && data.totalBytes > 0 ? Math.round((data.usedBytes / data.totalBytes) * 100) : null;
    return (
      <PanelShell title="Storage" icon={HardDrive}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Used</p>
            <p className="font-mono text-2xl tabular-nums">{formatBytes(data?.usedBytes)}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Total</p>
            <p className="font-mono text-2xl tabular-nums">{formatBytes(data?.totalBytes)}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Array</p>
            <p className="text-lg">{data ? humanState(data.state) : "—"}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Disks</p>
            <p className="font-mono text-2xl tabular-nums">{data?.disks.length ?? "—"}</p>
          </div>
        </div>
        {percent !== null && (
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, percent)}%` }} />
          </div>
        )}
      </PanelShell>
    );
  }

  if (panel === "network") {
    const interfaces = network.data?.data ?? null;
    const extras = overview?.extras ?? null;
    const ifaceCount = Array.isArray(interfaces)
      ? interfaces.filter((entry) => !entry.virtual).length
      : null;
    return (
      <PanelShell title="Network" icon={Network}>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">RX</p>
            <p className="font-mono text-2xl tabular-nums">{formatRate(extras?.primaryRx ?? null)}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">TX</p>
            <p className="font-mono text-2xl tabular-nums">{formatRate(extras?.primaryTx ?? null)}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Primary</p>
            <p className="truncate text-lg">{extras?.primaryInterface ?? "—"}</p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Ifaces</p>
            <p className="font-mono text-2xl tabular-nums">{ifaceCount ?? "—"}</p>
          </div>
        </div>
      </PanelShell>
    );
  }

  // overview panel is the NOC page's own tile grid; this should not render.
  return null;
}
