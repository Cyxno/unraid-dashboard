"use client";

import { useMemo, useState } from "react";
import {
  Activity,
  ChevronDown,
  ChevronUp,
  Cpu,
  Flame,
  Gauge,
  MemoryStick,
  Thermometer,
  Zap,
} from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import {
  HISTORY_INTERVAL_MS,
  PAGE_INTERVAL_MS,
  usePrefs,
  type HistoryWindowPref,
} from "@/lib/prefs";
import { PageHeader } from "@/components/dashboard/page-primitives";
import { MetricStatus, SectionStatus } from "@/components/dashboard/section-status";
import { SeriesChart, formatValue } from "@/components/dashboard/series-chart";
import { WindowPicker } from "@/components/dashboard/window-picker";
import {
  ThermalAnalysisCard,
  type ThermalAnalysisPayload,
} from "@/components/dashboard/thermal-analysis-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  formatBytes,
  formatPercent,
  formatTemp,
  formatUptime,
} from "@/lib/utils";
import { useOverview } from "@/components/layout/overview-provider";
import type {
  Section,
  SystemHistoryPayload,
  SystemInfo,
  SystemMetricsSnapshot,
} from "@/lib/api-types";

const METRIC_TABS = [
  { id: "cpu", label: "CPU", unit: "percent" },
  { id: "memory", label: "Memory", unit: "percent" },
  { id: "load", label: "Load", unit: "load" },
  { id: "network", label: "Network", unit: "rate" },
  { id: "disk", label: "Disk I/O", unit: "rate" },
  { id: "temps", label: "Temps", unit: "celsius" },
] as const;

type MetricTab = (typeof METRIC_TABS)[number]["id"];

function LoadLevelBadge({ level }: { level: string | null }) {
  if (!level) return null;
  if (level === "high") return <Badge variant="warning">high</Badge>;
  if (level === "elevated") return <Badge variant="secondary">elevated</Badge>;
  return <Badge variant="success">normal</Badge>;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm font-medium">{value}</dd>
    </div>
  );
}

/* Per-core grid: collapsed summary by default on many-thread systems. */

function PerCoreSection({
  perCore,
}: {
  perCore: SystemMetricsSnapshot["perCore"];
}) {
  const [expanded, setExpanded] = useState(false);
  const [sortByUtil, setSortByUtil] = useState(false);
  const { prefs } = usePrefs();

  const cores = useMemo(() => {
    const list = [...perCore].filter((core) => core.percent !== null);
    return sortByUtil
      ? list.sort((a, b) => (b.percent ?? 0) - (a.percent ?? 0))
      : list.sort(
          (a, b) =>
            Number.parseInt(a.id, 10) - Number.parseInt(b.id, 10) ||
            a.id.localeCompare(b.id),
        );
  }, [perCore, sortByUtil]);

  if (cores.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
        Per-core CPU metrics unavailable.
      </p>
    );
  }

  const busy = cores.filter((core) => (core.percent ?? 0) >= 50).length;
  const hottest = cores.reduce(
    (best, core) => ((core.percent ?? 0) > (best?.percent ?? -1) ? core : best),
    cores[0],
  );
  const previewCores = cores.slice(0, 8);
  const visible = expanded || cores.length <= 16 ? cores : previewCores;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {cores.length} threads · busiest {hottest?.id} at{" "}
          {formatPercent(hottest?.percent ?? null)}
          {busy > 0 && ` · ${busy} core(s) ≥50%`}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {cores.length > 16 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => setExpanded((value) => !value)}
            >
              {expanded ? (
                <>
                  <ChevronUp className="size-3" aria-hidden="true" /> Collapse
                </>
              ) : (
                <>
                  <ChevronDown className="size-3" aria-hidden="true" /> Show all
                </>
              )}
            </Button>
          )}
          <Button
            size="sm"
            variant={sortByUtil ? "secondary" : "ghost"}
            aria-pressed={sortByUtil}
            className="h-6 px-2 text-xs"
            onClick={() => setSortByUtil((value) => !value)}
          >
            Sort by utilization
          </Button>
        </div>
      </div>
      {prefs.showPerCore && (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
          {visible.map((core) => {
            const percent = core.percent ?? 0;
            return (
              <div
                key={core.id}
                className="rounded-md border bg-card px-2 py-1.5"
                title={`Thread ${core.id}: ${formatPercent(core.percent)}`}
              >
                <p className="truncate text-[11px] text-muted-foreground">
                  cpu{core.id}
                </p>
                <p className="font-mono text-xs tabular-nums">
                  {formatPercent(core.percent)}
                </p>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-secondary">
                  <div
                    className={
                      percent >= 90
                        ? "h-full rounded-full bg-destructive"
                        : percent >= 50
                          ? "h-full rounded-full bg-warning"
                          : "h-full rounded-full bg-success"
                    }
                    style={{ width: `${Math.min(100, percent)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function SystemPage() {
  const { data, error, loading } = usePoll<Section<SystemInfo>>(
    "/api/system",
    PAGE_INTERVAL_MS.system,
  );
  // /api/system/metrics returns { meta, data } — unwrap data.
  const snapshot = usePoll<{ meta: SystemMetricsSnapshot["meta"]; data: SystemMetricsSnapshot | null }>(
    "/api/system/metrics",
    PAGE_INTERVAL_MS.systemMetrics,
  );
  const { prefs, setPref } = usePrefs();
  const overview = useOverview();
  const info = data?.data ?? null;
  const temperature = info?.temperature ?? overview.data?.temperature.data ?? null;

  const [tab, setTab] = useState<MetricTab>("cpu");
  const thermalAnalysis = usePoll<ThermalAnalysisPayload>(
    "/api/thermal/analysis",
    60_000,
  );
  const history = usePoll<SystemHistoryPayload>(
    `/api/system/history?metric=${tab}&window=${prefs.historyWindow}`,
    HISTORY_INTERVAL_MS[prefs.historyWindow],
  );

  const snap = snapshot.data?.data ?? null;
  const snapMeta = snap?.meta ?? null;
  const promStatus = snapMeta?.status ?? "unavailable";
  const chartUnavailable = promStatus === "unavailable";
  const unit = METRIC_TABS.find((entry) => entry.id === tab)?.unit ?? "percent";
  const thermal = snap?.thermal ?? null;
  const load = snap?.load ?? null;

  return (
    <div>
      <PageHeader
        title="System"
        description="Platform, runtime metrics and thermals"
        actions={
          <SectionStatus
            section={
              data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }
            }
          />
        }
      />

      {error && !data && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        >
          System information unavailable: {error}
        </p>
      )}

      {/* Instant runtime snapshot -------------------------------------- */}
      <section aria-label="Runtime snapshot" className="mb-4">
        <Card>
          <CardContent className="grid grid-cols-2 gap-4 py-4 sm:grid-cols-3 xl:grid-cols-6">
            <div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Cpu className="size-3.5" aria-hidden="true" /> CPU
              </p>
              <p className="font-mono text-lg tabular-nums">
                {promStatus === "unavailable"
                  ? "—"
                  : formatPercent(snap?.cpuPercent ?? null)}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {snap?.load.threads !== null && snap?.load.threads !== undefined
                  ? `${snap.load.threads} threads`
                  : "per-core below"}
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Gauge className="size-3.5" aria-hidden="true" /> Load (1/5/15)
              </p>
              <p className="font-mono text-lg tabular-nums">
                {load?.one !== null && load?.one !== undefined
                  ? `${load.one.toFixed(2)} · ${load.five?.toFixed(2) ?? "—"} · ${load.fifteen?.toFixed(2) ?? "—"}`
                  : "—"}
              </p>
              <p className="mt-0.5">
                <LoadLevelBadge level={load?.level ?? null} />
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <MemoryStick className="size-3.5" aria-hidden="true" /> RAM
              </p>
              <p className="font-mono text-lg tabular-nums">
                {snap?.memory.usedBytes !== null &&
                snap?.memory.usedBytes !== undefined ? (
                  formatBytes(snap.memory.usedBytes)
                ) : (
                  "—"
                )}
              </p>
              <p className="text-[11px] text-muted-foreground">
                of {formatBytes(snap?.memory.totalBytes ?? null)}
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Thermometer className="size-3.5" aria-hidden="true" /> Package
              </p>
              <p
                className={`font-mono text-lg tabular-nums ${
                  (thermal?.packageC ?? 0) >= 90 ? "text-destructive" : (thermal?.packageC ?? 0) >= 80 ? "text-warning" : ""
                }`}
              >
                {promStatus === "unavailable"
                  ? "—"
                  : formatTemp(thermal?.packageC ?? null, prefs.tempUnit)}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {thermal?.hottestName
                  ? `hottest ${thermal.hottestName} ${formatTemp(thermal.hottestC, prefs.tempUnit)}`
                  : "no sensors"}
              </p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Zap className="size-3.5" aria-hidden="true" /> Power
              </p>
              <p className="font-mono text-lg tabular-nums">
                {formatValue(thermal?.powerWatts ?? null, "watts")}
              </p>
              <p className="text-[11px] text-muted-foreground">platform (PSYS)</p>
            </div>
            <div>
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Activity className="size-3.5" aria-hidden="true" /> Uptime
              </p>
              <p className="font-mono text-lg tabular-nums">
                {formatUptime(
                  overview.data?.identity.data?.uptimeSeconds ??
                    snap?.uptimeSeconds ??
                    null,
                )}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {snapMeta?.status === "stale" ? "metrics stale" : "live"}
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* Per-core CPU ---------------------------------------------------- */}
      <section aria-label="Per-core CPU" className="mb-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Per-core CPU</CardTitle>
          </CardHeader>
          <CardContent>
            {snap ? (
              <PerCoreSection perCore={snap.perCore} />
            ) : (
              <Skeleton className="h-20 w-full" />
            )}
          </CardContent>
        </Card>
      </section>

      {/* History charts --------------------------------------------------- */}
      <section aria-label="Metrics history" className="mb-4">
        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
              <div className="flex flex-wrap items-center gap-1">
              {METRIC_TABS.map((entry) => (
                <Button
                  key={entry.id}
                  size="sm"
                  variant={tab === entry.id ? "secondary" : "ghost"}
                  aria-pressed={tab === entry.id}
                  onClick={() => setTab(entry.id)}
                  className="h-7 px-2.5 text-xs"
                >
                  {entry.label}
                </Button>
              ))}
              </div>
              <div className="sm:ml-auto">
                <WindowPicker
                  value={prefs.historyWindow}
                  onChange={(value: HistoryWindowPref) => setPref("historyWindow", value)}
                />
              </div>
            </div>
            <CardTitle className="text-base">
              <span className="flex items-center gap-2">
                <Flame className="size-4 text-muted-foreground" aria-hidden="true" />
                {METRIC_TABS.find((entry) => entry.id === tab)?.label} history
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <MetricStatus meta={history.data?.meta ?? null} />
            {history.loading && !history.data ? (
              <Skeleton className="h-[240px] w-full" />
            ) : (
              <>
                <SeriesChart
                  series={
                    tab === "memory"
                      ? (history.data?.series ?? []).filter(
                          (series) => series.name === "memory-percent",
                        )
                      : history.data?.series ?? []
                  }
                  breakdown={tab === "cpu" ? history.data?.breakdown ?? [] : []}
                  unit={unit}
                  unavailable={chartUnavailable}
                  unavailableReason="History unavailable — Prometheus is unreachable. Unraid state pages remain live."
                />
                {tab === "temps" && <ThermalAnalysisCard payload={thermalAnalysis.data} />}
                {tab === "temps" && (
                  <ThermalHistoryList payload={history.data} />
                )}
                {history.data?.summary && (tab === "cpu" || tab === "memory") && (
                  <p className="text-[11px] text-muted-foreground">
                    min {formatValue(history.data.summary.min, unit)} · avg{" "}
                    {formatValue(history.data.summary.avg, unit)} · max{" "}
                    {formatValue(history.data.summary.max, unit)} over{" "}
                    {prefs.historyWindow}
                    {history.data.meta.status === "stale" && " · stale data shown"}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </section>

      {/* Platform info cards ---------------------------------------------- */}
      {loading && !data ? null : info ? (
        <section aria-label="Platform information" className="grid gap-3 lg:grid-cols-2 [&>*]:min-w-0">
          <Card>
            <CardHeader>
              <CardTitle>Operating system</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Hostname" value={info.hostname ?? "—"} />
                <Row label="OS" value={info.distro ?? "—"} />
                <Row
                  label="Version"
                  value={
                    overview.data?.identity.data?.osVersion
                      ? `v${overview.data.identity.data.osVersion}`
                      : "—"
                  }
                />
                <Row label="Kernel" value={info.kernel ?? "—"} />
                <Row label="Architecture" value={info.arch ?? "—"} />
                <Row
                  label="Boot mode"
                  value={info.uefi === null ? "—" : info.uefi ? "UEFI" : "Legacy BIOS"}
                />
                <Row
                  label="Uptime"
                  value={formatUptime(overview.data?.identity.data?.uptimeSeconds)}
                />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>CPU &amp; memory</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Processor" value={info.cpuBrand ?? "—"} />
                <Row
                  label="Cores / threads"
                  value={
                    info.cpuCores ? `${info.cpuCores} / ${info.cpuThreads ?? "—"}` : "—"
                  }
                />
                <Row
                  label="Clock"
                  value={info.cpuSpeedGhz ? `${info.cpuSpeedGhz.toFixed(2)} GHz` : "—"}
                />
                <Row label="Memory total" value={formatBytes(snap?.memory.totalBytes ?? info.memoryTotalBytes)} />
                <Row
                  label="Memory available"
                  value={formatBytes(snap?.memory.availableBytes ?? null)}
                />
                <Row label="Cached / buffers" value={`${formatBytes(snap?.memory.cachedBytes ?? null)} / ${formatBytes(snap?.memory.buffersBytes ?? null)}`} />
                <Row
                  label="Swap"
                  value={
                    snap?.memory.swapTotalBytes && snap.memory.swapTotalBytes > 0
                      ? `${formatBytes(snap.memory.swapUsedBytes)} of ${formatBytes(snap.memory.swapTotalBytes)}`
                      : "Not enabled"
                  }
                />
                <Row
                  label="Temperature"
                  value={
                    temperature && temperature.cpuC !== null ? (
                      <span className="inline-flex items-center gap-1">
                        <Thermometer
                          className="size-3.5 text-muted-foreground"
                          aria-hidden="true"
                        />
                        {formatTemp(temperature.cpuC, prefs.tempUnit)}
                        {temperature.warningCount + temperature.criticalCount > 0 &&
                          ` · ${temperature.warningCount + temperature.criticalCount} over threshold`}
                      </span>
                    ) : (
                      formatTemp(thermal?.packageC ?? null, prefs.tempUnit)
                    )
                  }
                />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Motherboard</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Board" value={info.boardModel ?? "—"} />
                <Row label="Manufacturer" value={info.boardManufacturer ?? "—"} />
                <Row label="System" value={info.systemModel ?? "—"} />
                <Row label="System vendor" value={info.systemManufacturer ?? "—"} />
                <Row
                  label="Virtualized"
                  value={
                    info.virtualized === null
                      ? "—"
                      : info.virtualized
                        ? "Yes"
                        : "No (bare metal)"
                  }
                />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <span className="flex items-center gap-2">
                  <Activity className="size-4 text-muted-foreground" aria-hidden="true" />
                  Notes
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                Runtime metrics and history come from Prometheus (node-exporter
                + homelab-exporter, 15s scrape). Load is judged relative to
                the CPU thread count, never an absolute threshold.
              </p>
              <p>
                Fan speeds and NVMe temperatures are not exposed by any
                exporter on this host. Disk temperatures live on the Storage
                page (Unraid reports them directly).
              </p>
            </CardContent>
          </Card>
        </section>
      ) : null}
    </div>
  );
}

/* Thermal history list: current/min/max per sensor over the range. */

function ThermalHistoryList({
  payload,
}: {
  payload: SystemHistoryPayload | null;
}) {
  const { prefs } = usePrefs();
  const stats = payload?.sensorStats ?? [];

  if (!payload || payload.series.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
        No temperature sensors reported by Prometheus.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full min-w-[420px] text-sm">
        <caption className="sr-only">Temperature sensors over the selected range</caption>
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th scope="col" className="px-3 py-2 font-medium">Sensor</th>
            <th scope="col" className="px-3 py-2 font-medium">Category</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Current</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Min</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Max</th>
          </tr>
        </thead>
        <tbody>
          {stats.slice(0, 12).map((sensor) => (
            <tr key={sensor.id} className="border-b last:border-0">
              <td className="max-w-[200px] truncate px-3 py-2 font-medium">{sensor.name}</td>
              <td className="px-3 py-2 text-xs text-muted-foreground">{sensor.category}</td>
              <td className="px-3 py-2 text-right font-mono tabular-nums">
                {formatTemp(sensor.current, prefs.tempUnit)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {formatTemp(sensor.min, prefs.tempUnit)}
              </td>
              <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                {formatTemp(sensor.max, prefs.tempUnit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
