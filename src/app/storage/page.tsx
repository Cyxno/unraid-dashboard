"use client";

import { HardDrive, Thermometer } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import {
  HISTORY_INTERVAL_MS,
  PAGE_INTERVAL_MS,
  usePrefs,
  type HistoryWindowPref,
} from "@/lib/prefs";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { MetricStatus, SectionStatus } from "@/components/dashboard/section-status";
import { SeriesChart } from "@/components/dashboard/series-chart";
import { WindowPicker } from "@/components/dashboard/window-picker";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatBytes, formatPercent, formatRate, formatTemp, humanState } from "@/lib/utils";
import type {
  DiskIoSnapshot,
  Section,
  StorageHistoryPayload,
  StorageUsage,
} from "@/lib/api-types";

const COLOR_CLASS: Record<string, string> = {
  GREEN: "bg-success",
  YELLOW: "bg-warning",
  RED: "bg-destructive",
  RED_BALL: "bg-destructive",
  BLUE: "bg-blue-400",
  GREY: "bg-muted-foreground",
};

/** Storage keeps its own window default; capacity and performance stay separate. */
function usePersistedWindow(): [
  HistoryWindowPref,
  (value: HistoryWindowPref) => void,
] {
  const { prefs, setPref } = usePrefs();
  const allowed: HistoryWindowPref[] = ["15m", "1h", "6h", "24h"];
  const window = allowed.includes(prefs.historyWindow)
    ? prefs.historyWindow
    : "1h";
  return [window, (value) => setPref("historyWindow", value)];
}

function AggregateCard({
  label,
  value,
  detail,
  warn,
}: {
  label: string;
  value: string;
  detail?: string;
  warn?: boolean;
}) {
  return (
    <Card className="gap-0 p-4">
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 font-mono text-xl font-semibold tabular-nums", warn && "text-warning")}>
        {value}
      </p>
      {detail && <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>}
    </Card>
  );
}

export default function StoragePage() {
  const { data, error, loading } = usePoll<Section<StorageUsage>>(
    "/api/storage",
    PAGE_INTERVAL_MS.storage,
  );
  const { prefs } = usePrefs();
  const storage = data?.data ?? null;

  /* Runtime disk I/O (Prometheus) + performance history. Capacity views
     above stay purely Unraid; performance views are clearly separate. */
  const [window, setWindow] = usePersistedWindow();
  const diskIo = usePoll<DiskIoSnapshot>(
    "/api/storage/io",
    PAGE_INTERVAL_MS.docker,
  );
  const history = usePoll<StorageHistoryPayload>(
    `/api/storage/history?window=${window}`,
    HISTORY_INTERVAL_MS[window],
  );

  const ioByDevice = new Map(
    (diskIo.data?.devices ?? []).map((device) => [device.device, device]),
  );

  // Aggregate data-disks only for "usable" capacity — parity disks hold no
  // user data and cache pools are separate tiers, so summing everything would
  // produce a misleading total.
  const dataDisks = storage?.disks.filter((disk) => disk.role === "data") ?? [];
  const cacheDisks = storage?.disks.filter((disk) => disk.role === "cache") ?? [];
  const sum = (disks: typeof dataDisks, key: "sizeBytes" | "usedBytes" | "freeBytes") =>
    disks.reduce<number>((sum, disk) => sum + (disk[key] ?? 0), 0);

  const dataTotal = sum(dataDisks, "sizeBytes");
  const dataUsed = sum(dataDisks, "usedBytes");

  return (
    <div>
      <PageHeader
        title="Storage"
        description="Array, pools and disk health"
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
          Storage data unavailable: {error}
        </p>
      )}

      {loading && !data ? (
        <LoadingPanel rows={6} />
      ) : storage ? (
        <div className="space-y-4">
          <section
            aria-label="Storage totals"
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
          >
            <AggregateCard
              label="Array state"
              value={humanState(storage.state)}
              warn={storage.state !== "STARTED"}
            />
            <AggregateCard
              label="Parity"
              value={humanState(storage.parityStatus)}
              detail={
                storage.parityProgressPercent !== null
                  ? `${storage.parityProgressPercent}%`
                  : undefined
              }
            />
            <AggregateCard
              label="Data disks"
              value={`${dataDisks.length}`}
              detail={`${formatBytes(dataUsed)} of ${formatBytes(dataTotal)} used`}
            />
            <AggregateCard
              label="Cache / pools"
              value={`${cacheDisks.length}`}
              detail={`${formatBytes(sum(cacheDisks, "usedBytes"))} of ${formatBytes(sum(cacheDisks, "sizeBytes"))} used`}
            />
          </section>

          {/* Runtime disk activity (Prometheus) ---------------------------- */}
          <Card>
            <CardHeader className="gap-2">
              <CardTitle className="text-base">Disk activity</CardTitle>
              <MetricStatus meta={diskIo.data?.meta ?? null} />
            </CardHeader>
            <CardContent>
              {diskIo.loading && !diskIo.data ? (
                <Skeleton className="h-24 w-full" />
              ) : diskIo.data === null ? (
                <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  Disk I/O unavailable — Prometheus is unreachable. Capacity
                  and health data remain live from Unraid.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <caption className="sr-only">Runtime disk activity per device</caption>
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <th scope="col" className="px-3 py-2 font-medium">Disk</th>
                        <th scope="col" className="px-3 py-2 font-medium">Device</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">Read</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">Write</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">Read IOPS</th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">Write IOPS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {storage?.disks
                        .filter((disk) => disk.device !== null && ioByDevice.has(disk.device))
                        .map((disk) => {
                          const io = ioByDevice.get(disk.device!)!;
                          return (
                            <tr key={disk.device} className="border-b last:border-0">
                              <td className="px-3 py-2.5 font-medium">{disk.name}</td>
                              <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                                {disk.device}
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                                {formatRate(io.readBytesPerSec)}
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                                {formatRate(io.writeBytesPerSec)}
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                                {io.readIops !== null ? io.readIops.toFixed(1) : "—"}
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono text-xs tabular-nums text-muted-foreground">
                                {io.writeIops !== null ? io.writeIops.toFixed(1) : "—"}
                              </td>
                            </tr>
                          );
                        })}
                      <tr className="font-medium">
                        <td className="px-3 py-2.5" colSpan={2}>
                          Total (all physical devices)
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                          {formatRate(diskIo.data.totals.readBytesPerSec)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                          {formatRate(diskIo.data.totals.writeBytesPerSec)}
                        </td>
                        <td className="px-3 py-2.5" colSpan={2} />
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">
                Unraid disks are matched to exporter devices by kernel name
                (sdX). Parity disks report device-level I/O from rebuilds and
                reads. The array layer (md) is excluded so member-disk and
                array I/O are never double-counted.
              </p>
            </CardContent>
          </Card>

          {/* Performance history (Prometheus) ------------------------------- */}
          <Card>
            <CardHeader className="gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="mr-auto text-base">
                  Performance history
                </CardTitle>
                <WindowPicker
                  value={window}
                  onChange={setWindow}
                  options={["15m", "1h", "6h", "24h"]}
                />
              </div>
              <MetricStatus meta={history.data?.meta ?? null} />
            </CardHeader>
            <CardContent className="space-y-4">
              {history.data === null ? (
                <Skeleton className="h-[200px] w-full" />
              ) : history.data.meta.status === "unavailable" ? (
                <div className="flex h-[200px] items-center justify-center rounded-md border border-dashed px-6 text-center text-sm text-muted-foreground">
                  Performance history unavailable — Prometheus is unreachable.
                </div>
              ) : (
                <>
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">
                      Aggregate throughput
                    </p>
                    <SeriesChart
                      series={[
                        { name: "Read", points: history.data.totals.read },
                        { name: "Write", points: history.data.totals.write },
                      ]}
                      unit="rate"
                      height={200}
                    />
                  </div>
                  <div>
                    <p className="mb-1 text-xs text-muted-foreground">
                      Per-device throughput (top devices)
                    </p>
                    <SeriesChart
                      series={history.data.read}
                      breakdown={history.data.write}
                      unit="rate"
                      height={180}
                      maxSeries={4}
                    />
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Disks</CardTitle>
              <span className="text-xs text-muted-foreground">
                {storage.disks.length} total
              </span>
            </CardHeader>
            <CardContent>
              {storage.disks.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No disks reported.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[680px] text-sm">
                    <caption className="sr-only">Disks</caption>
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                        <th scope="col" className="px-3 py-2 font-medium">Disk</th>
                        <th scope="col" className="px-3 py-2 font-medium">Role</th>
                        <th scope="col" className="px-3 py-2 font-medium">Health</th>
                        <th scope="col" className="px-3 py-2 font-medium">Utilization</th>
                        <th scope="col" className="px-3 py-2 font-medium">Filesystem</th>
                        <th scope="col" className="px-3 py-2 font-medium">Temp</th>
                      </tr>
                    </thead>
                    <tbody>
                      {storage.disks.map((disk) => {
                        const percent =
                          disk.sizeBytes && disk.usedBytes !== null && disk.sizeBytes > 0
                            ? (disk.usedBytes / disk.sizeBytes) * 100
                            : null;
                        const colorClass = disk.fsColor
                          ? (COLOR_CLASS[disk.fsColor] ?? "bg-muted-foreground")
                          : disk.state === "DISK_OK"
                            ? "bg-success"
                            : "bg-warning";
                        return (
                          <tr key={`${disk.role}-${disk.name}`} className="border-b last:border-0">
                            <td className="px-3 py-2.5 font-medium">{disk.name}</td>
                            <td className="px-3 py-2.5">
                              <Badge variant="muted">{disk.role}</Badge>
                            </td>
                            <td className="px-3 py-2.5">
                              <span className="inline-flex items-center gap-2">
                                <span
                                  className={cn("size-2 rounded-full", colorClass)}
                                  aria-hidden="true"
                                />
                                {humanState(disk.state)}
                              </span>
                            </td>
                            <td className="w-48 px-3 py-2.5">
                              {percent !== null ? (
                                <div className="flex items-center gap-2">
                                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                                    <div
                                      className={cn(
                                        "h-full rounded-full",
                                        percent >= 90
                                          ? "bg-destructive"
                                          : percent >= 75
                                            ? "bg-warning"
                                            : "bg-primary",
                                      )}
                                      style={{ width: `${percent}%` }}
                                    />
                                  </div>
                                  <span className="w-10 text-right font-mono text-xs tabular-nums text-muted-foreground">
                                    {formatPercent(percent, 0)}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">—</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">
                              {disk.fsType ?? "—"}
                            </td>
                            <td className="px-3 py-2.5 font-mono text-xs tabular-nums text-muted-foreground">
                              {disk.temperatureC != null ? (
                                <span className="inline-flex items-center gap-1">
                                  <Thermometer className="size-3" aria-hidden="true" />
                                  {formatTemp(disk.temperatureC, prefs.tempUnit)}
                                </span>
                              ) : (
                                "—"
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">
                Health dots reflect Unraid&apos;s disk color/state (green = ok).
                SMART detail views are not exposed by the Unraid GraphQL API.
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <HardDrive className="size-4" aria-hidden="true" /> Storage data unavailable.
        </p>
      )}
    </div>
  );
}
