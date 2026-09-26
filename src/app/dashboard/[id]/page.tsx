"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  Clock,
  Cpu,
  HardDrive,
  MemoryStick,
  Search,
  Thermometer,
  TriangleAlert,
} from "lucide-react";
import { MetricCard, MetricCardSkeleton } from "@/components/dashboard/metric-card";
import { SeriesChart } from "@/components/dashboard/series-chart";
import { DockerOverviewList } from "@/components/dashboard/docker-overview-list";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { SectionStatus } from "@/components/dashboard/section-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePoll } from "@/hooks/use-poll";
import { usePrefs, PAGE_INTERVAL_MS, HISTORY_INTERVAL_MS } from "@/lib/prefs";
import { dashboardToSavedView, fetchSharedDashboard } from "@/lib/dashboards";
import { formatBytes, formatPercent, formatRate, formatTemp, formatUptime, humanState } from "@/lib/utils";
import type { DockerSummary, OverviewPayload, Section, SharedDashboardDto } from "@/lib/api-types";

/**
 * Shared dashboard view (/dashboard/<id>): renders a server-stored layout
 * read-only. Layout fields (widget order/visibility) drive the grid; the
 * dashboard's time window and density are applied locally for this page.
 * No lifecycle controls.
 */

export default function SharedDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [dashboard, setDashboard] = useState<SharedDashboardDto | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const { setPref } = usePrefs();

  const window_ = dashboard?.preferences.historyWindow ?? "15m";

  useEffect(() => {
    let cancelled = false;
    fetchSharedDashboard(id)
      .then((loaded) => {
        if (cancelled) return;
        setDashboard(loaded);
        setFilter(loaded.preferences.dockerFilter);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Failed to load dashboard");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const overview = usePoll<OverviewPayload>(
    `/api/overview?window=${window_}`,
    dashboard ? PAGE_INTERVAL_MS.overview : 60_000,
  );
  const docker = usePoll<Section<DockerSummary>>("/api/docker", PAGE_INTERVAL_MS.docker);

  // Apply the dashboard's preferences to the local session while viewing
  // (density, unit, docker columns) so embedded widgets render as saved.
  useEffect(() => {
    if (!dashboard) return;
    const view = dashboardToSavedView(dashboard);
    setPref("density", view.density);
    setPref("tempUnit", view.tempUnit);
    setPref("dockerMetrics", view.dockerMetrics);
    setPref("showPerCore", view.showPerCore);
  }, [dashboard, setPref]);

  const payload = overview.data;
  const visibleOrder = useMemo(
    () => (dashboard ? dashboard.layout.order.filter((widget) => !dashboard.layout.hidden.includes(widget)) : []),
    [dashboard],
  );

  const filteredContainers = useMemo(() => {
    const data = docker.data?.data;
    if (!data) return null;
    const needle = filter.trim().toLowerCase();
    if (!needle) return data;
    return {
      ...data,
      containers: data.containers.filter(
        (container) =>
          container.name.toLowerCase().includes(needle) ||
          container.image.toLowerCase().includes(needle),
      ),
    };
  }, [docker.data, filter]);

  if (loadError) {
    return (
      <div className="space-y-3">
        <PageHeader title="Shared dashboard" description="This shared dashboard could not be loaded." />
        <Card>
          <CardContent className="flex items-center gap-3 pt-4 text-sm">
            <TriangleAlert className="size-4 text-destructive" aria-hidden="true" />
            <span>{loadError}</span>
          </CardContent>
        </Card>
        <Button asChild variant="outline" size="sm">
          <Link href="/">Back to overview</Link>
        </Button>
      </div>
    );
  }

  if (!dashboard) {
    return <LoadingPanel rows={6} />;
  }

  const renderWidget = (widgetId: string) => {
    if (!payload) return <MetricCardSkeleton key={widgetId} />;
    const cpu = payload.cpu;
    const memory = payload.memory;
    const storage = payload.storage;
    const network = payload.network;
    const dockerSection = payload.docker;
    const identity = payload.identity;
    const thermal = payload.extras?.thermal ?? null;
    const load = payload.extras?.load ?? null;

    switch (widgetId) {
      case "cpu":
        return (
          <MetricCard
            key="cpu"
            label="CPU"
            icon={Cpu}
            section={cpu}
            value={formatPercent(cpu.data?.percentTotal)}
            percent={cpu.data?.percentTotal ?? null}
            detail={
              thermal?.packageC != null ? (
                <span className="inline-flex items-center gap-1">
                  <Thermometer className="size-3" aria-hidden="true" />
                  {formatTemp(thermal.packageC, dashboard.preferences.tempUnit)}
                </span>
              ) : load?.five != null ? (
                `load ${load.five.toFixed(2)}`
              ) : undefined
            }
          />
        );
      case "memory":
        return (
          <MetricCard
            key="memory"
            label="Memory"
            icon={MemoryStick}
            section={memory}
            value={formatPercent(memory.data?.percentTotal)}
            percent={memory.data?.percentTotal ?? null}
            detail={`${formatBytes(memory.data?.usedBytes)} of ${formatBytes(memory.data?.totalBytes)}`}
          />
        );
      case "uptime":
        return (
          <MetricCard
            key="uptime"
            label="Uptime"
            icon={Clock}
            section={identity}
            value={formatUptime(identity.data?.uptimeSeconds)}
            detail={identity.data?.osVersion ? `Unraid v${identity.data.osVersion}` : undefined}
          />
        );
      case "array":
        return (
          <MetricCard
            key="array"
            label="Array usage"
            icon={HardDrive}
            section={storage}
            value={formatBytes(storage.data?.usedBytes)}
            percent={
              storage.data && storage.data.totalBytes > 0
                ? (storage.data.usedBytes / storage.data.totalBytes) * 100
                : null
            }
            detail={
              storage.data
                ? `of ${formatBytes(storage.data.totalBytes)} · ${storage.data.disks.length} disks · ${humanState(storage.data.state)}`
                : undefined
            }
          />
        );
      case "network":
        return (
          <MetricCard
            key="network"
            label="Network"
            icon={ArrowDownToLine}
            section={network}
            value={formatRate(payload.extras?.primaryRx ?? network.data?.rxBytesPerSec)}
            detail={
              <span className="inline-flex items-center gap-1">
                <ArrowUpFromLine className="size-3" aria-hidden="true" />
                TX {formatRate(payload.extras?.primaryTx ?? network.data?.txBytesPerSec)}
              </span>
            }
          />
        );
      default:
        return (
          <MetricCard
            key="docker"
            label="Docker"
            icon={Boxes}
            section={dockerSection}
            value={dockerSection.data ? `${dockerSection.data.running}/${dockerSection.data.total}` : "—"}
            detail={`${filteredContainers?.containers.length ?? dockerSection.data?.containers.length ?? 0} shown below`}
          />
        );
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={dashboard.name}
        description={`Shared dashboard · owner ${dashboard.owner} · read-only view`}
      />

      {overview.error && payload && (
        <p role="alert" className="text-xs text-warning">
          Refresh failed ({overview.error}) — showing last known data.
        </p>
      )}

      <section aria-label="Shared layout" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {visibleOrder.map((widgetId) => renderWidget(widgetId))}
      </section>

      {payload && (
        <section aria-label="History" className="min-w-0">
          <SeriesChart
            series={[
              {
                name: "CPU %",
                points: payload.history.samples.map((sample) => ({
                  t: sample.time,
                  v: Number.isFinite(sample.cpu) ? sample.cpu : null,
                })),
              },
              {
                name: "RAM %",
                points: payload.history.samples.map((sample) => ({
                  t: sample.time,
                  v: Number.isFinite(sample.memory) ? sample.memory : null,
                })),
              },
            ]}
            unit="percent"
            unavailable={payload.history.status === "unavailable" && payload.history.samples.length === 0}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="muted">window {window_}</Badge>
            <p className="text-[11px] text-muted-foreground">
              applies the shared dashboard&apos;s default window ({HISTORY_INTERVAL_MS[window_] / 1000}s refresh)
            </p>
          </div>
        </section>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Boxes className="size-4 text-muted-foreground" aria-hidden="true" />
            Containers
            {dashboard.preferences.dockerFilter && (
              <Badge variant="muted">saved filter: {dashboard.preferences.dockerFilter}</Badge>
            )}
          </CardTitle>
          <SectionStatus section={docker.data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }} />
        </CardHeader>
        <CardContent className="pt-1">
          <div className="mb-3 flex items-center gap-2">
            <Search className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Filter by name or image…"
              aria-label="Filter containers"
              className="h-8 w-full max-w-xs rounded-md border bg-transparent px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {filteredContainers && docker.data ? (
            <DockerOverviewList docker={{ ...docker.data, data: filteredContainers }} />
          ) : (
            <LoadingPanel rows={3} />
          )}
        </CardContent>
      </Card>

      <p className="text-[11px] text-muted-foreground">
        Shared layouts live on the server and are read-only here. Copy one into your local views
        from the Views menu (Shared → copy icon).
      </p>
    </div>
  );
}
