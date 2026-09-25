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
import { ResourceChart } from "@/components/dashboard/resource-chart";
import { StorageOverview } from "@/components/dashboard/storage-overview";
import { DockerOverviewList } from "@/components/dashboard/docker-overview-list";
import { NotificationsCard } from "@/components/dashboard/notifications-card";
import { usePrefs } from "@/lib/prefs";
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
  const { prefs } = usePrefs();
  const payload = overview.data;
  const loading = overview.loading && !payload;

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
                        {cpu.data?.brand ? (
                          <span className="block truncate">{cpu.data.brand}</span>
                        ) : null}
                        {temp && (temp.cpuC !== null || temp.criticalCount > 0) ? (
                          <span
                            className={
                              temp.criticalCount > 0
                                ? "inline-flex items-center gap-1 text-destructive"
                                : "inline-flex items-center gap-1"
                            }
                          >
                            <Thermometer className="size-3" aria-hidden="true" />
                            {formatTemp(temp.cpuC, prefs.tempUnit)}
                            {temp.criticalCount > 0 &&
                              ` · ${temp.criticalCount} critical`}
                            {temp.warningCount > 0 &&
                              temp.criticalCount === 0 &&
                              ` · ${temp.warningCount} over limit`}
                          </span>
                        ) : null}
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
                      storage.data
                        ? `of ${formatBytes(storage.data.totalBytes)} · ${storage.data.disks.length} disks · ${humanState(storage.data.state)}`
                        : undefined
                    }
                  />
                  <MetricCard
                    label="Network"
                    icon={ArrowDownToLine}
                    section={network}
                    value={formatRate(network.data?.rxBytesPerSec)}
                    detail={
                      <span className="inline-flex items-center gap-1">
                        <ArrowUpFromLine className="size-3" aria-hidden="true" />
                        TX {formatRate(network.data?.txBytesPerSec)}
                      </span>
                    }
                  />
                  <MetricCard
                    label="Docker"
                    icon={Boxes}
                    section={docker}
                    value={
                      docker.data
                        ? `${docker.data.running}/${docker.data.total}`
                        : "—"
                    }
                    detail={
                      <Link
                        href="/docker"
                        className="underline-offset-2 hover:underline"
                      >
                        View containers
                      </Link>
                    }
                  />
                </>
              );
            })()}
      </section>

      {payload && (
        <section aria-label="Resource history and storage" className="grid gap-3 xl:grid-cols-2">
          <ResourceChart
            samples={payload.history.samples}
            window={payload.history.window}
            windowFilled={payload.history.windowFilled}
            totalSamples={payload.history.totalSamples}
            loading={loading}
          />
          <StorageOverview storage={payload.storage} />
        </section>
      )}

      {payload && (
        <section aria-label="Containers and events" className="grid gap-3 xl:grid-cols-2">
          <DockerOverviewList docker={payload.docker} />
          <NotificationsCard notifications={payload.notifications} />
        </section>
      )}
    </div>
  );
}
