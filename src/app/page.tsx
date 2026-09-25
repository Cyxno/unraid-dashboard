"use client";

import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Boxes, Clock, Cpu, HardDrive, MemoryStick } from "lucide-react";
import { useOverviewContext } from "@/components/layout/overview-provider";
import { StatCard, StatCardSkeleton } from "@/components/dashboard/stat-card";
import { ResourceChart } from "@/components/dashboard/resource-chart";
import { StorageOverview } from "@/components/dashboard/storage-overview";
import { DockerList } from "@/components/dashboard/docker-list";
import { NotificationsCard } from "@/components/dashboard/notifications-card";
import { formatBytes, formatPercent, formatRate, formatUptime } from "@/lib/utils";

export default function OverviewPage() {
  const { snapshot, error, loading, history } = useOverviewContext();
  const data = snapshot?.data ?? null;
  const degraded = snapshot != null && snapshot.reason != null;

  return (
    <div className="space-y-6">
      {error && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        >
          <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden="true" />
          <p>
            Could not reach the dashboard backend: {error} — retrying automatically.
          </p>
        </div>
      )}
      {degraded && snapshot?.reason && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
        >
          <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden="true" />
          <p>{snapshot.reason}</p>
        </div>
      )}

      <section aria-label="Resource summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {loading && !data ? (
          [...Array(6)].map((_, index) => <StatCardSkeleton key={index} />)
        ) : data ? (
          <>
            <StatCard
              label="CPU"
              icon={Cpu}
              value={formatPercent(data.cpu.percentTotal)}
              percent={data.cpu.percentTotal}
              detail={data.cpu.brand ?? (data.cpu.cores ? `${data.cpu.cores} cores` : undefined)}
            />
            <StatCard
              label="Memory"
              icon={MemoryStick}
              value={formatPercent(data.memory.percentTotal)}
              percent={data.memory.percentTotal}
              detail={`${formatBytes(data.memory.usedBytes)} / ${formatBytes(data.memory.totalBytes)}`}
            />
            <StatCard
              label="Uptime"
              icon={Clock}
              value={formatUptime(data.identity.uptimeSeconds)}
              detail={data.identity.osVersion ? `Unraid v${data.identity.osVersion}` : undefined}
            />
            <StatCard
              label="Storage"
              icon={HardDrive}
              value={formatBytes(data.storage.usedBytes)}
              percent={
                data.storage.totalBytes > 0
                  ? (data.storage.usedBytes / data.storage.totalBytes) * 100
                  : null
              }
              detail={`of ${formatBytes(data.storage.totalBytes)} · ${data.storage.disks.length} disks`}
            />
            <StatCard
              label="Network"
              icon={ArrowDownToLine}
              value={formatRate(data.network.rxBytesPerSec)}
              detail={
                <span className="inline-flex items-center gap-1">
                  <ArrowUpFromLine className="size-3" aria-hidden="true" />
                  TX {formatRate(data.network.txBytesPerSec)}
                </span>
              }
              iconClassName="text-chart-2"
            />
            <StatCard
              label="Docker"
              icon={Boxes}
              value={`${data.docker.running}/${data.docker.total}`}
              detail="containers running"
            />
          </>
        ) : null}
      </section>

      <section aria-label="System resource history" className="grid gap-4 xl:grid-cols-2">
        <ResourceChart history={history} loading={loading} />
        <StorageOverview storage={data?.storage ?? null} loading={loading} />
      </section>

      <section aria-label="Containers and events" className="grid gap-4 xl:grid-cols-2">
        <DockerList docker={data?.docker ?? null} loading={loading} />
        <NotificationsCard notifications={data?.notifications ?? null} loading={loading} />
      </section>
    </div>
  );
}
