"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  ChevronDown,
  Cpu,
  Gauge,
  HardDrive,
  Maximize,
  MemoryStick,
  Minimize,
  Pause,
  Play,
  Settings2,
  Thermometer,
  X,
} from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BeaconMark } from "@/components/brand/logo";
import { usePoll } from "@/hooks/use-poll";
import { PAGE_INTERVAL_MS, usePrefs } from "@/lib/prefs";
import { useLive } from "@/components/layout/live-events";
import { usePwa } from "@/components/layout/pwa-provider";
import { fetchDashboards } from "@/lib/dashboards";
import { dashboardToSavedView } from "@/lib/dashboards";
import { formatBytes, formatPercent, formatRate, formatTemp, formatUptime, humanState } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { StatusDot } from "@/components/ui/status";
import { NOC_LAYOUT_SEEDS, NOC_WIDGETS, nocWidgetDef, normalizeNocLayout, type NocWidgetSize } from "@/lib/noc-widgets";
import { CYCLE_PANELS, CyclePanel, type CyclePanelId } from "./panels";
import { WidgetGrid } from "@/components/dashboard/widget-registry";
import type {
  DockerSummary,
  OverviewPayload,
  Section,
  SharedDashboardDto,
  SystemMetricsSnapshot,
} from "@/lib/api-types";

/**
 * NOC wallboard v3: fullscreen, dense, auto-refreshing, read-only.
 *
 * v3 additions: shared-dashboard selection (layout applied), auto-cycle
 * across Overview/Docker/Thermal/Storage/Network with pause-on-interaction,
 * connection state + last-update timestamp, wake-lock re-acquisition, and
 * a kiosk variant (?mode=kiosk) with larger touch targets and a page rail.
 * No lifecycle controls exist here by design.
 */

const CYCLE_OPTIONS = [
  { value: 0, label: "off" },
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
  { value: 60, label: "60s" },
] as const;

/** Seconds of no interaction before auto-cycle resumes after a pause. */
const CYCLE_RESUME_AFTER_IDLE_S = 30;

function useFullscreen() {
  const [isFullscreen, setIsFullscreen] = useState(false);
  // iOS Safari (iPhone/iPad) exposeert geen Fullscreen API voor pagina's:
  // de knop zou niets doen. Beschikbaarheid wordt expliciet gedetecteerd.
  const supported =
    typeof document !== "undefined" &&
    (Boolean(document.documentElement.requestFullscreen) ||
      Boolean((document.documentElement as unknown as { webkitRequestFullscreen?: unknown }).webkitRequestFullscreen));
  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement || (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);
  const enter = () => {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    if (el.requestFullscreen) void el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) void el.webkitRequestFullscreen().catch(() => {});
  };
  const exit = () => {
    const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
    if (document.exitFullscreen) void document.exitFullscreen().catch(() => {});
    else if (doc.webkitExitFullscreen) void doc.webkitExitFullscreen().catch(() => {});
  };
  return { isFullscreen, supported, enter, exit };
}

/** Wake lock with re-acquisition on visibility change. */
function useWakeLock() {
  const [held, setHeld] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let sentinel: { release: () => Promise<void> } | null = null;
    let released = false;
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: "screen") => Promise<{ release: () => Promise<void> }> };
    };
    const acquire = async () => {
      if (released || !nav.wakeLock) return;
      try {
        sentinel = await nav.wakeLock.request("screen");
        setHeld(true);
        setFailed(false);
      } catch {
        // Denied or unsupported — show it, never block the wallboard.
        setFailed(true);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible" && !sentinel) void acquire();
    };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, []);
  return { held, failed };
}

function Tile({
  label,
  value,
  sub,
  alert,
  icon: Icon,
  large,
}: {
  label: string;
  value: string;
  sub?: string | null;
  alert?: boolean;
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  large?: boolean;
}) {
  // Alert mode: semantic danger ring + value tint — restrained, no blinking.
  return (
    <div
      className={cn(
        "rounded-xl border bg-card/70 shadow-card",
        large ? "p-6" : "p-4",
        alert && "border-danger/70 ring-1 ring-danger/40",
      )}
    >
      <p className={cn("flex items-center gap-1.5 uppercase tracking-wider text-muted-foreground", large ? "text-sm" : "text-xs")}>
        <Icon className="size-3.5" aria-hidden={true} />
        {label}
        {alert && <span className="ml-auto inline-block size-2 rounded-full bg-danger" aria-hidden={true} />}
      </p>
      <p className={cn("tnum mt-2 font-mono font-semibold leading-none", large ? "text-6xl" : "text-4xl", alert && "text-danger")}>
        {value}
      </p>
      {sub && <p className={cn("mt-2 truncate text-muted-foreground", large ? "text-base" : "text-xs")}>{sub}</p>}
    </div>
  );
}

export default function NocPage() {
  return (
    <Suspense fallback={<div className="safe-frame min-h-svh bg-background" />}>
      <NocShell />
    </Suspense>
  );
}

function NocShell() {
  const searchParams = useSearchParams();
  const kiosk = searchParams.get("mode") === "kiosk";
  const overview = usePoll<OverviewPayload>("/api/overview?window=15m", PAGE_INTERVAL_MS.overview);
  const { status } = useLive();
  const { online } = usePwa();
  const { prefs, setPref } = usePrefs();
  const snapshot = usePoll<{ meta: import("@/lib/api-types").MetricMeta; data: SystemMetricsSnapshot | null }>(
    "/api/system/metrics",
    PAGE_INTERVAL_MS.systemMetrics,
  );
  const docker = usePoll<Section<DockerSummary>>("/api/docker", PAGE_INTERVAL_MS.docker);
  const { isFullscreen, supported: fullscreenSupported, enter, exit } = useFullscreen();
  const wakeLock = useWakeLock();

  const [panelsOpen, setPanelsOpen] = useState(false);
  // v0.9.3 per-widget layout: edit mode + normalized config from prefs.
  const [editLayout] = useState(false);
  const widgetLayout = normalizeNocLayout(prefs.nocWidgetLayout.order.length > 0 ? prefs.nocWidgetLayout : { order: NOC_LAYOUT_SEEDS[prefs.nocLayout] ?? NOC_LAYOUT_SEEDS.full, sizes: prefs.nocWidgetLayout.sizes });
  const [clock, setClock] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const [shared, setShared] = useState<SharedDashboardDto[] | null>(null);
  const [cycleIndex, setCycleIndex] = useState(0);
  const [cyclePaused, setCyclePaused] = useState(false);
  // 0 = no interaction yet → cycling starts immediately from load; any
  // pointer/key/wheel activity re-arms the 30s resume window.
  const lastInteraction = useRef<number>(0);

  // Applied shared dashboard (layout drives density/window hints in NOC).
  const dashboard = useMemo(
    () => shared?.find((entry) => entry.id === prefs.nocDashboardId) ?? null,
    [shared, prefs.nocDashboardId],
  );

  useEffect(() => {
    let cancelled = false;
    fetchDashboards()
      .then((payload) => {
        if (!cancelled) setShared(payload.dashboards);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Shared dashboard preferences apply to the NOC view where they make
  // sense (time window hint is shown; the wallboard tiles are fixed).
  useEffect(() => {
    if (!dashboard) return;
    const view = dashboardToSavedView(dashboard);
    setPref("density", view.density);
    setPref("tempUnit", view.tempUnit);
  }, [dashboard, setPref]);

  // Auto-cycle: interval-driven panel rotation, paused on interaction and
  // resumed after 30s idle. Interaction = pointer or key activity.
  const cycleSeconds = prefs.nocCycleSeconds;
  useEffect(() => {
    const markInteraction = () => {
      lastInteraction.current = Date.now();
    };
    window.addEventListener("pointerdown", markInteraction);
    window.addEventListener("keydown", markInteraction);
    window.addEventListener("wheel", markInteraction, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", markInteraction);
      window.removeEventListener("keydown", markInteraction);
      window.removeEventListener("wheel", markInteraction);
    };
  }, []);

  useEffect(() => {
    if (cycleSeconds <= 0) return;
    const timer = setInterval(() => {
      // Pause-on-interaction: skip while the user interacted recently;
      // auto-resume after the idle window. The explicit pause button
      // holds indefinitely until pressed again.
      const idleFor = (Date.now() - lastInteraction.current) / 1000;
      if (cyclePaused || idleFor < CYCLE_RESUME_AFTER_IDLE_S) return;
      setCycleIndex((current) => (current + 1) % CYCLE_PANELS.length);
    }, Math.max(5, cycleSeconds) * 1000);
    return () => clearInterval(timer);
  }, [cycleSeconds, cyclePaused]);

  const activePanel: CyclePanelId = CYCLE_PANELS[cycleIndex]?.id ?? "overview";
  const lastUpdated = overview.updatedAt;

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

  const togglePause = useCallback(() => setCyclePaused((value) => !value), []);

  const payload = overview.data;
  const extras = payload?.extras ?? null;
  const snap = snapshot.data?.data ?? null;
  const snapStatus = snapshot.data?.meta.status;
  const health = payload?.health;
  const topCpu = extras?.topConsumers?.cpu.slice(0, 5) ?? [];

  const connectionLabel =
    !online
      ? "offline"
      : status === "connected"
        ? "live"
        : status === "reconnecting"
          ? "reconnecting…"
          : status;

  return (
    <div className={cn("safe-frame min-h-svh bg-background", kiosk && "text-lg")}>
      {/* Header: identity + verdict + clock/context */}
      <div className="mb-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <BeaconMark className="size-9 rounded-lg" aria-hidden={true} />
        <p
          role={health?.level === "critical" ? "alert" : "status"}
          className={cn(
            "flex min-w-0 shrink items-center gap-2 font-semibold",
            kiosk ? "text-xl" : "text-base",
            health?.level === "critical"
              ? "text-danger"
              : health?.level === "attention"
                ? "text-warning"
                : "text-success",
          )}
        >
          <StatusDot
            tone={health?.level === "critical" ? "critical" : health?.level === "attention" ? "warning" : "healthy"}
            pulse={health?.level === "critical"}
            className="size-3"
          />
          {health?.level === "critical" ? "NEEDS ATTENTION" : health?.level === "attention" ? "WARNING" : "ALL SYSTEMS NOMINAL"}
        </p>
        {payload?.identity.data && (
          <span className="hidden min-w-0 text-sm text-muted-foreground sm:inline">
            {payload.identity.data.serverName} · up {formatUptime(payload.identity.data.uptimeSeconds)}
          </span>
        )}
        {/* Clock/date: subtle context, right-aligned */}
        <span className="tnum ml-auto hidden shrink-0 text-sm text-muted-foreground sm:inline" aria-hidden={true}>
          {clock.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })} ·{" "}
          {clock.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </span>

        {/* Connection state + last update (NOC v3) */}
        <span
          className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground sm:text-xs"
          aria-live="polite"
        >
          <StatusDot
            tone={!online ? "critical" : status === "connected" ? "healthy" : "warning"}
            pulse={!online ? false : status !== "connected"}
            className="size-2"
          />
          {connectionLabel}
          {lastUpdated && (
            <span title="Last data update">· {new Date(lastUpdated).toLocaleTimeString()}</span>
          )}
          {wakeLock.failed && <span title="Screen wake lock unavailable">· no wake lock</span>}
        </span>

        {/* NOC controls */}
        <div className="flex shrink-0 items-center gap-1">
          {cycleSeconds > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-xs"
              onClick={togglePause}
              aria-label={cyclePaused ? "Resume auto-cycle" : "Pause auto-cycle"}
            >
              {cyclePaused ? <Play className="size-3.5" aria-hidden={true} /> : <Pause className="size-3.5" aria-hidden={true} />}
              {cyclePaused ? "paused" : "cycling"}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={panelsOpen}
            aria-label="NOC settings"
            onClick={() => setPanelsOpen((value) => !value)}
            className="gap-1 text-xs"
          >
            <Settings2 className="size-3.5" aria-hidden={true} />
            <ChevronDown className={cn("size-3 transition", panelsOpen && "rotate-180")} aria-hidden={true} />
          </Button>
          {(fullscreenSupported || isFullscreen) && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 text-xs"
              onClick={isFullscreen ? exit : enter}
              aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            >
              {isFullscreen ? <Minimize className="size-3.5" aria-hidden={true} /> : <Maximize className="size-3.5" aria-hidden={true} />}
              {!kiosk && (isFullscreen ? "Exit" : "Fullscreen")}
            </Button>
          )}
          <Button variant="ghost" size="sm" asChild className="shrink-0" aria-label="Exit NOC mode">
            <Link href="/">
              <X className="size-4" aria-hidden={true} /> {!kiosk && "Exit"}
            </Link>
          </Button>
        </div>
      </div>

      {/* NOC settings drawer */}
      {panelsOpen && (
        <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border bg-card/60 p-3 text-xs">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Layout</span>
            <div role="group" aria-label="NOC layout preset" className="flex items-center gap-1">
              {(["full", "performance", "storage", "minimal"] as const).map((layout) => (
                <Button
                  key={layout}
                  size="sm"
                  variant={prefs.nocLayout === layout ? "secondary" : "ghost"}
                  aria-pressed={prefs.nocLayout === layout}
                  onClick={() => setPref("nocLayout", layout)}
                  className="h-6 px-2 text-[11px] capitalize"
                >
                  {layout}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">Auto-cycle</span>
            <div role="group" aria-label="Auto-cycle interval" className="flex items-center gap-1">
              {CYCLE_OPTIONS.map((option) => (
                <Button
                  key={option.value}
                  size="sm"
                  variant={prefs.nocCycleSeconds === option.value ? "secondary" : "ghost"}
                  aria-pressed={prefs.nocCycleSeconds === option.value}
                  onClick={() => setPref("nocCycleSeconds", option.value)}
                  className="h-6 px-2 text-[11px]"
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-muted-foreground">Dashboard</span>
            <select
              value={prefs.nocDashboardId ?? ""}
              onChange={(event) => setPref("nocDashboardId", event.target.value || null)}
              aria-label="Shared dashboard for NOC mode"
              className="h-7 max-w-[220px] rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="">Built-in tiles</option>
              {(shared ?? []).map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Auto-cycle pauses on interaction and resumes after {CYCLE_RESUME_AFTER_IDLE_S}s idle.
            Wake lock: {wakeLock.held ? "held" : wakeLock.failed ? "unavailable" : "requesting…"}
          </p>
        </div>
      )}

      {health && health.reasons.length > 0 && (
        <p className={cn("mb-4 truncate text-sm", health.level === "critical" ? "text-danger" : "text-warning")}>
          {health.reasons.join(" · ")}
        </p>
      )}

      {/* Shared-dashboard banner */}
      {dashboard && (
        <p className="mb-3 text-xs text-muted-foreground">
          Shared dashboard <strong>{dashboard.name}</strong> (owner {dashboard.owner}) — window{" "}
          {dashboard.preferences.historyWindow}, {dashboard.preferences.density}.
        </p>
      )}

      {/* Selected shared dashboard: render its widget layout read-only.
          Auto-cycle applies to the built-in panels only. */}
      {dashboard ? (
        <WidgetGrid
          widgets={dashboard.widgets}
          overview={payload}
          preferences={{
            tempUnit: dashboard.preferences.tempUnit,
            dockerFilter: dashboard.preferences.dockerFilter,
            networkInterface: dashboard.preferences.networkInterface,
          }}
          compact={dashboard.preferences.density === "compact"}
        />
      ) : (
      /* Main tiles (built-in) or cycled panel. Layout preset (v0.9.2) selects
         which tiles render: full / performance / storage / minimal. */
      activePanel === "overview" || cycleSeconds === 0 ? (
        <>
        <div>
        {/* Registry-driven tile grid (v0.9.3). Edit mode: reorder/hide/size. */}
        {editLayout && (
          <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-card/60 p-2 text-xs">
            <span className="text-muted-foreground">Editing layout — use the controls on each tile. Hidden:</span>
            {NOC_WIDGETS.filter((widget) => !widgetLayout.order.includes(widget.id)).map((widget) => (
              <Button
                key={widget.id}
                size="sm"
                variant="outline"
                className="h-6 px-2 text-[11px]"
                onClick={() => setPref("nocWidgetLayout", { order: [...widgetLayout.order, widget.id], sizes: widgetLayout.sizes })}
              >
                + {widget.title}
              </Button>
            ))}
            {NOC_WIDGETS.every((widget) => widgetLayout.order.includes(widget.id)) && (
              <span className="text-muted-foreground">none</span>
            )}
          </div>
        )}
        <div className={cn("grid gap-3", kiosk ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-2 lg:grid-cols-4 xl:grid-cols-8")}>
          {widgetLayout.order.map((widgetId) => {
            const def = nocWidgetDef(widgetId);
            if (!def) return null;
            const size: NocWidgetSize = widgetLayout.sizes[widgetId] ?? "1x1";
            const span = size === "2x2" ? "sm:col-span-2 lg:row-span-2" : "";
            const large = kiosk || size === "2x2";
            const tileProps = {
              large,
            };
            const editControls = editLayout ? (
              <div className="mt-2 flex items-center justify-end gap-1">
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" aria-label={`Move ${def.title} up`}
                  onClick={() => {
                    const order = [...widgetLayout.order];
                    const index = order.indexOf(widgetId);
                    if (index > 0) {
                      [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
                      setPref("nocWidgetLayout", { order, sizes: widgetLayout.sizes });
                    }
                  }}>
                ↑</Button>
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" aria-label={`Move ${def.title} down`}
                  onClick={() => {
                    const order = [...widgetLayout.order];
                    const index = order.indexOf(widgetId);
                    if (index < order.length - 1) {
                      [order[index + 1], order[index]] = [order[index]!, order[index + 1]!];
                      setPref("nocWidgetLayout", { order, sizes: widgetLayout.sizes });
                    }
                  }}>
                ↓</Button>
                {def.allowedSizes.length > 1 && (
                  <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px]" aria-label={`Resize ${def.title}`}
                    onClick={() => {
                      const next: NocWidgetSize = size === "1x1" ? "2x2" : "1x1";
                      setPref("nocWidgetLayout", { order: widgetLayout.order, sizes: { ...widgetLayout.sizes, [widgetId]: next } });
                    }}>
                  {size}</Button>
                )}
                <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[10px] text-danger" aria-label={`Hide ${def.title}`}
                  onClick={() => setPref("nocWidgetLayout", { order: widgetLayout.order.filter((id) => id !== widgetId), sizes: widgetLayout.sizes })}>
                ✕</Button>
              </div>
            ) : null;

            if (widgetId === "cpu") {
              return (
                <div key={widgetId} className={span}>
                <Tile label="CPU" icon={Cpu} value={formatPercent(snap?.cpuPercent ?? payload?.cpu.data?.percentTotal)} sub={extras?.load?.five !== null && extras?.load ? `load ${extras.load.five?.toFixed(2)} · ${extras.load.threads ?? "?"} threads` : null} alert={(snap?.cpuPercent ?? 0) >= 90} {...tileProps} />
                {editControls}
                </div>
              );
            }
            if (widgetId === "ram") {
              return (
                <div key={widgetId} className={span}>
                <Tile label="RAM" icon={MemoryStick} value={formatPercent(payload?.memory.data?.percentTotal)} sub={payload?.memory.data ? `${formatBytes(payload.memory.data.usedBytes)} / ${formatBytes(payload.memory.data.totalBytes)}` : null} alert={(payload?.memory.data?.percentTotal ?? 0) >= 90} {...tileProps} />
                {editControls}
                </div>
              );
            }
            if (widgetId === "temp") {
              return (
                <div key={widgetId} className={span}>
                <Tile label="Package" icon={Thermometer} value={snapStatus === "unavailable" ? "—" : formatTemp(snap?.thermal?.packageC ?? null, "C")} sub={snap?.thermal?.hottestName ? `hottest ${snap.thermal.hottestName}` : null} alert={(snap?.thermal?.packageC ?? 0) >= 90} {...tileProps} />
                {editControls}
                </div>
              );
            }
            if (widgetId === "array") {
              return (
                <div key={widgetId} className={span}>
                <Tile label="Array" icon={HardDrive} value={formatBytes(payload?.storage.data?.usedBytes)} sub={payload?.storage.data ? `${humanState(payload.storage.data.state)} · ${payload.storage.data.disks.length} disks` : null} alert={payload?.storage.data?.state !== "STARTED"} {...tileProps} />
                {editControls}
                </div>
              );
            }
            if (widgetId === "docker") {
              return (
                <div key={widgetId} className={span}>
                <Tile label="Docker" icon={Boxes} value={docker.data?.data ? `${docker.data.data.running}/${docker.data.data.total}` : "—"} sub={extras?.unhealthyContainers ? `${extras.unhealthyContainers} unhealthy` : "all healthy"} alert={(extras?.unhealthyContainers ?? 0) > 0} {...tileProps} />
                {editControls}
                </div>
              );
            }
            if (widgetId === "ntrx") {
              return (
                <div key={widgetId} className={span}>
                <Tile label="Net RX" icon={ArrowDownToLine} value={formatRate(extras?.primaryRx ?? payload?.network.data?.rxBytesPerSec)} sub={extras?.primaryInterface ?? null} {...tileProps} />
                {editControls}
                </div>
              );
            }
            if (widgetId === "ntxt") {
              return (
                <div key={widgetId} className={span}>
                <Tile label="Net TX" icon={ArrowUpFromLine} value={formatRate(extras?.primaryTx ?? payload?.network.data?.txBytesPerSec)} sub={extras?.diskIo ? `disk ${formatRate(extras.diskIo.readBytesPerSec)} r` : null} {...tileProps} />
                {editControls}
                </div>
              );
            }
            if (widgetId === "load") {
              return (
                <div key={widgetId} className={span}>
                <Tile label="Load 5" icon={Gauge} value={extras?.load?.five !== null && extras?.load ? extras.load.five.toFixed(2) : "—"} sub={extras?.load?.level ? `level: ${extras.load.level}` : null} {...tileProps} />
                {editControls}
                </div>
              );
            }
            return null;
          })}
        </div>
        {/* Secondary registry widgets (2x-wide cards). */}
        {widgetLayout.order.includes("topcpu") && (
          <div className={cn("mt-3 grid gap-3", kiosk ? "lg:grid-cols-1" : "lg:grid-cols-2")}>
            <div className={cn("rounded-xl border bg-card/70 shadow-card p-4", kiosk && "text-lg", widgetLayout.sizes.topcpu === "2x2" && "sm:col-span-2")}>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Top CPU consumers</p>
              <ul className={cn("mt-2 space-y-1.5", kiosk && "text-base")}>
                {topCpu.map((entry) => (
                  <li key={entry.name} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm">{entry.name}</span>
                    <span className="tnum font-mono text-sm">{formatPercent(entry.percent)}</span>
                    <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, entry.percent ?? 0)}%` }} />
                    </div>
                  </li>
                ))}
                {topCpu.length === 0 && <li className="text-sm text-muted-foreground">unavailable</li>}
              </ul>
            </div>
          </div>
        )}
        {widgetLayout.order.includes("diskio") && (
          <div className={cn("mt-3 rounded-xl border bg-card/70 shadow-card p-4", widgetLayout.sizes.diskio === "2x2" && "sm:col-span-2")}>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Disk throughput</p>
            {extras?.diskIo ? (
              <div className={cn("mt-2 flex items-center gap-6", kiosk && "text-lg")}>
                <p className="tnum font-mono text-2xl">{formatRate(extras.diskIo.readBytesPerSec)}</p>
                <p className="text-xs text-muted-foreground">read</p>
                <p className="tnum font-mono text-2xl">{formatRate(extras.diskIo.writeBytesPerSec)}</p>
                <p className="text-xs text-muted-foreground">write</p>
              </div>
            ) : (
              <p className="mt-2 text-sm text-muted-foreground">unavailable</p>
            )}
          </div>
        )}
        </div>
        </>
      ) : (
        <CyclePanel panel={activePanel} overview={payload} />
      )
      )
      }

      {/* Cycle indicator (built-in panels only) */}
      {!dashboard && cycleSeconds > 0 && (
        <div className="mt-3 flex items-center gap-2">
          {CYCLE_PANELS.map((panel, index) => (
            <span
              key={panel.id}
              aria-hidden="true"
              className={cn(
                "h-1.5 rounded-full transition-all",
                index === cycleIndex ? "w-8 bg-primary" : "w-3 bg-muted",
              )}
            />
          ))}
          <span className="text-[11px] text-muted-foreground">{CYCLE_PANELS[cycleIndex]?.label}</span>
        </div>
      )}

      {/* Secondary row (built-in overview only) */}
      {!dashboard && (activePanel === "overview" || cycleSeconds === 0) && (
        <div className={cn("mt-4 grid gap-3", kiosk ? "lg:grid-cols-1" : "lg:grid-cols-2")}>
          <div className="rounded-lg border bg-card/60 p-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Top CPU consumers</p>
            <ul className={cn("mt-2 space-y-1.5", kiosk && "text-base")}>
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
              <div className={cn("mt-2 flex items-center gap-6", kiosk && "text-lg")}>
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
      )}

      {/* Kiosk page rail: large touch targets, still read-only */}
      {kiosk && (
        <nav aria-label="Kiosk pages" className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            { href: "/", label: "Overview" },
            { href: "/docker", label: "Containers" },
            { href: "/system", label: "System & Temps" },
            { href: "/storage", label: "Storage" },
          ].map((entry) => (
            <Link
              key={entry.href}
              href={entry.href}
              className="flex min-h-[72px] items-center justify-center rounded-xl border bg-card/60 text-lg font-medium hover:bg-secondary/60"
            >
              {entry.label}
            </Link>
          ))}
        </nav>
      )}

      <p className={cn("mt-4 text-[11px] text-muted-foreground")}>
        NOC mode is read-only by design — no lifecycle controls are exposed here.
      </p>
    </div>
  );
}
