"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  Clock,
  Cpu,
  HardDrive,
  MemoryStick,
  Thermometer,
} from "lucide-react";
import Link from "next/link";
import { useOverview } from "@/components/layout/overview-provider";
import { MetricCard, MetricCardSkeleton } from "@/components/dashboard/metric-card";
import { SeriesChart } from "@/components/dashboard/series-chart";
import { WindowPicker } from "@/components/dashboard/window-picker";
import { TopConsumersCard } from "@/components/dashboard/top-consumers";
import { StorageOverview } from "@/components/dashboard/storage-overview";
import { DockerOverviewList } from "@/components/dashboard/docker-overview-list";
import { NotificationsCard } from "@/components/dashboard/notifications-card";
import { MetricStatus } from "@/components/dashboard/section-status";
import { usePrefs, type HistoryWindowPref } from "@/lib/prefs";
import {
  formatBytes,
  formatPercent,
  formatRate,
  formatTemp,
  formatUptime,
  humanState,
} from "@/lib/utils";
import type { HealthSummary } from "@/lib/api-types";

function HealthBanner({ health }: { health: HealthSummary }) {
  if (!health.level || health.level === "healthy") return null;
  const critical = health.level === "critical";
  return (
    <section
      role={critical ? "alert" : "status"}
      aria-label={`System health: ${health.level}`}
      className={
        critical
          ? "rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
          : "rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
      }
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <span
          aria-hidden="true"
          className={
            critical
              ? "size-2 rounded-full bg-destructive"
              : "size-2 animate-pulse rounded-full bg-warning"
          }
        />
        {critical ? "Needs attention" : "Warning"}
      </p>
      <ul className="mt-1 list-inside list-disc text-sm text-muted-foreground">
        {health.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
    </section>
  );
}

export default function OverviewPage() {
  const overview = useOverview();
  const { prefs, setPref } = usePrefs();
  const payload = overview.data;
  const loading = overview.loading && !payload;
  const extras = payload?.extras ?? null;

  return (
    <div className="space-y-5">
      {overview.error && payload && (
        <p role="alert" className="text-xs text-warning">
          Refresh failed ({overview.error}) — showing last known data, retrying.
        </p>
      )}
      {payload?.health && <HealthBanner health={payload.health} />}

      <section
        aria-label="Resource summary"
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      >
        {loading || !payload
          ? Array.from({ length: 6 }).map((_, index) => (
              <MetricCardSkeleton key={index} />
            ))
          : (() => {
              const cpu = payload.cpu;
              const memory = payload.memory;
              const storage = payload.storage;
              const network = payload.network;
              const docker = payload.docker;
              const identity = payload.identity;
              const temp = payload.temperature.data;
              const thermal = extras?.thermal ?? null;
              const load = extras?.load ?? null;
              const unhealthy = extras?.unhealthyContainers ?? 0;
              const highMem = extras?.highMemoryContainers ?? 0;
              return (
                <>
                  <MetricCard
                    label="CPU"
                    icon={Cpu}
                    section={cpu}
                    value={formatPercent(cpu.data?.percentTotal)}
                    percent={cpu.data?.percentTotal ?? null}
                    detail={
                      <>
                        {load && load.five !== null ? (
                          <span className="block">
                            load {load.one?.toFixed(2) ?? "—"} / {load.five.toFixed(2)} /{" "}
                            {load.fifteen?.toFixed(2) ?? "—"}
                            {load.threads !== null && ` · ${load.threads} threads`}
                          </span>
                        ) : null}
                        {thermal && thermal.packageC !== null ? (
                          <span
                            className={`inline-flex items-center gap-1 ${
                              (thermal.peak1hC ?? 0) >= 90 ? "text-destructive" : ""
                            }`}
                          >
                            <Thermometer className="size-3" aria-hidden="true" />
                            {formatTemp(thermal.packageC, prefs.tempUnit)}
                            {thermal.peak1hC !== null &&
                              ` · 1h peak ${formatTemp(thermal.peak1hC, prefs.tempUnit)}`}
                          </span>
                        ) : null}
                        {temp && temp.criticalCount > 0 && (
                          <span className="block text-destructive">
                            {temp.criticalCount} sensor(s) critical
                          </span>
                        )}
                      </>
                    }
                  />
                  <MetricCard
                    label="Memory"
                    icon={MemoryStick}
                    section={memory}
                    value={formatPercent(memory.data?.percentTotal)}
                    percent={memory.data?.percentTotal ?? null}
                    detail={`${formatBytes(memory.data?.usedBytes)} of ${formatBytes(memory.data?.totalBytes)}`}
                  />
                  <MetricCard
                    label="Uptime"
                    icon={Clock}
                    section={identity}
                    value={formatUptime(identity.data?.uptimeSeconds)}
                    detail={
                      identity.data?.osVersion
                        ? `Unraid v${identity.data.osVersion}`
                        : undefined
                    }
                  />
                  <MetricCard
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
                      storage.data ? (
                        <>
                          <span className="block">
                            of {formatBytes(storage.data.totalBytes)} · {storage.data.disks.length}{" "}
                            disks · {humanState(storage.data.state)}
                          </span>
                          {extras?.diskIo &&
                            (extras.diskIo.readBytesPerSec !== null ||
                              extras.diskIo.writeBytesPerSec !== null) && (
                              <span className="block">
                                disk I/O ↓ {formatRate(extras.diskIo.readBytesPerSec)} · ↑{" "}
                                {formatRate(extras.diskIo.writeBytesPerSec)}
                              </span>
                            )}
                        </>
                      ) : undefined
                    }
                  />
                  <MetricCard
                    label="Network"
                    icon={ArrowDownToLine}
                    section={network}
                    value={formatRate(extras?.primaryRx ?? network.data?.rxBytesPerSec)}
                    detail={
                      <>
                        <span className="inline-flex items-center gap-1">
                          <ArrowUpFromLine className="size-3" aria-hidden="true" />
                          TX {formatRate(extras?.primaryTx ?? network.data?.txBytesPerSec)}
                        </span>
                        {extras?.primaryInterface && (
                          <span className="block">{extras.primaryInterface}</span>
                        )}
                      </>
                    }
                  />
                  <MetricCard
                    label="Docker"
                    icon={Boxes}
                    section={docker}
                    value={
                      docker.data ? `${docker.data.running}/${docker.data.total}` : "—"
                    }
                    detail={
                      <>
                        {(unhealthy > 0 || highMem > 0) && (
                          <span className="block">
                            {unhealthy > 0 && `${unhealthy} unhealthy`}
                            {unhealthy > 0 && highMem > 0 && " · "}
                            {highMem > 0 && `${highMem} high memory`}
                          </span>
                        )}
                        <Link
                          href="/docker"
                          className="underline-offset-2 hover:underline"
                        >
                          View containers
                        </Link>
                      </>
                    }
                  />
                </>
              );
            })()}
      </section>

      {payload && (
        <section aria-label="Resource history and storage" className="grid gap-3 xl:grid-cols-2">
          <div className="xl:col-span-1">
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
              unavailable={
                payload.history.status === "unavailable" &&
                payload.history.samples.length === 0
              }
              unavailableReason={
                payload.history.source !== "prometheus"
                  ? "History unavailable — Prometheus unreachable and the in-memory buffer is still filling."
                  : undefined
              }
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <WindowPicker
                value={prefs.historyWindow}
                onChange={(value: HistoryWindowPref) => setPref("historyWindow", value)}
              />
              <p className="text-[11px] text-muted-foreground">
                {payload.history.source === "prometheus"
                  ? `source: Prometheus · ${payload.history.status}`
                  : "source: in-memory buffer (Prometheus unavailable)"}
                {payload.history.status === "stale" && " · stale"}
              </p>
            </div>
          </div>
          <StorageOverview storage={payload.storage} />
        </section>
      )}

      {payload && (
        <section aria-label="Containers and events" className="grid gap-3 xl:grid-cols-2">
          <div className="space-y-3">
            <TopConsumersCard consumers={extras?.topConsumers ?? null} />
            <DockerOverviewList docker={payload.docker} />
          </div>
          <div className="space-y-3">
            <NotificationsCard notifications={payload.notifications} />
            {extras && !extras.prometheus.configured && (
              <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                Prometheus is not configured — runtime metrics, history and
                container charts are hidden. Unraid state remains live. Set
                PROMETHEUS_URL to enable them.
              </p>
            )}
            {extras?.prometheus.configured && extras.prometheus.status !== "live" && (
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                <MetricStatus meta={{
                  source: "prometheus",
                  status: extras.prometheus.status,
                  sampledAt: "",
                  reason: extras.prometheus.reason,
                }} />
                <p className="mt-1 text-muted-foreground">
                  Prometheus-derived widgets may be empty or stale. Unraid state
                  pages remain live.
                </p>
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
