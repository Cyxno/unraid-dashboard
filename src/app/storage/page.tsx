"use client";

import { ArrowDownToLine, ArrowUpFromLine, HardDrive, Thermometer } from "lucide-react";
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
import { StatusDot, type StatusTone } from "@/components/ui/status";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CapacityBar,
  arrayHealthLabel,
  arrayHealthTone,
  diskHealthLabel,
  diskHealthTone,
  diskTempTone,
  utilizationToneClass,
} from "@/components/storage/health";
import { cn, formatBytes, formatPercent, formatRate, formatTemp } from "@/lib/utils";
import type {
  DiskIoSnapshot,
  ArrayDiskUsage,
  MetricMeta,
  Section,
  StorageHistoryPayload,
  StorageUsage,
} from "@/lib/api-types";

/**
 * Storage (v0.9.1 bespoke redesign):
 *   top    — array hero: verdict, capacity bar, warnings, live IO
 *   middle — unified disk view (health-first table on desktop, cards on mobile)
 *   bottom — performance history (Prometheus)
 *
 * All health color resolves through storage/health.tsx — no ad-hoc palette.
 */

/** Storage keeps its own window default; capacity and performance stay separate. */
function usePersistedWindow(): [HistoryWindowPref, (value: HistoryWindowPref) => void] {
  const { prefs, setPref } = usePrefs();
  const allowed: HistoryWindowPref[] = ["15m", "1h", "6h", "24h"];
  const window = allowed.includes(prefs.historyWindow) ? prefs.historyWindow : "1h";
  return [window, (value) => setPref("historyWindow", value)];
}

function HeroStat({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail?: React.ReactNode;
  tone?: StatusTone;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground">
        {tone && <StatusDot tone={tone} />}
        {label}
      </dt>
      <dd className="tnum mt-0.5 truncate text-xl font-semibold">{value}</dd>
      {detail && <dd className="truncate text-xs text-muted-foreground">{detail}</dd>}
    </div>
  );
}

function DiskTemp({ tempC, unit }: { tempC: number | null; unit: "C" | "F" }) {
  const tone = diskTempTone(tempC);
  return (
    <span className="inline-flex items-center gap-1.5">
      {tone && <StatusDot tone={tone} />}
      <span
        className={cn(
          "tnum",
          tone === "critical" && "font-medium text-danger",
          tone === "warning" && "font-medium text-warning",
        )}
      >
        {formatTemp(tempC, unit)}
      </span>
    </span>
  );
}

export default function StoragePage() {
  const { data, error, loading } = usePoll<Section<StorageUsage>>("/api/storage", PAGE_INTERVAL_MS.storage);
  const { prefs } = usePrefs();
  const storage = data?.data ?? null;
  const tempUnit = prefs.tempUnit;

  /* Runtime disk I/O (Prometheus) + performance history. Capacity views
     above stay purely Unraid; performance views are clearly separate. */
  const [window, setWindow] = usePersistedWindow();
  const diskIo = usePoll<{ meta: MetricMeta; data: DiskIoSnapshot | null }>("/api/storage/io", PAGE_INTERVAL_MS.docker);
  const diskIoData = diskIo.data?.data ?? null;
  const history = usePoll<StorageHistoryPayload>(`/api/storage/history?window=${window}`, HISTORY_INTERVAL_MS[window]);

  const ioByDevice = new Map((diskIoData?.devices ?? []).map((device) => [device.device, device]));

  // Aggregate data-disks only for "usable" capacity — parity disks hold no
  // user data and cache pools are separate tiers, so summing everything would
  // produce a misleading total.
  const dataDisks = storage?.disks.filter((disk) => disk.role === "data") ?? [];
  const cacheDisks = storage?.disks.filter((disk) => disk.role === "cache") ?? [];
  const sum = (disks: ArrayDiskUsage[], key: "sizeBytes" | "usedBytes" | "freeBytes") =>
    disks.reduce<number>((sum, disk) => sum + (disk[key] ?? 0), 0);

  const dataTotal = sum(dataDisks, "sizeBytes");
  const dataUsed = sum(dataDisks, "usedBytes");
  const dataFree = sum(dataDisks, "freeBytes");
  const dataPercent = dataTotal > 0 ? (dataUsed / dataTotal) * 100 : null;
  const cacheTotal = sum(cacheDisks, "sizeBytes");
  const cacheUsed = sum(cacheDisks, "usedBytes");
  const cachePercent = cacheTotal > 0 ? (cacheUsed / cacheTotal) * 100 : null;

  const warnings = (storage?.disks ?? []).filter((disk) => {
    const tone = diskHealthTone(disk);
    return tone === "warning" || tone === "critical";
  });
  const criticals = (storage?.disks ?? []).filter((disk) => diskHealthTone(disk) === "critical");
  const hotDisks = (storage?.disks ?? []).filter((disk) => (disk.temperatureC ?? 0) >= 45);
  const arrayTone = storage ? arrayHealthTone(storage.state, storage.disks) : "offline";

  /** Merged disk rows: Unraid facts + Prometheus IO (desktop table + mobile cards). */
  const diskRows = (storage?.disks ?? []).map((disk) => ({
    disk,
    io: disk.device !== null ? (ioByDevice.get(disk.device) ?? null) : null,
    tone: diskHealthTone(disk),
    label: diskHealthLabel(disk),
    percent:
      disk.sizeBytes && disk.usedBytes !== null && disk.sizeBytes > 0
        ? (disk.usedBytes / disk.sizeBytes) * 100
        : null,
  }));

  const renderIoRead = (row: (typeof diskRows)[number]) => formatRate(row.io?.readBytesPerSec ?? null);
  const renderIoWrite = (row: (typeof diskRows)[number]) => formatRate(row.io?.writeBytesPerSec ?? null);

  return (
    <div>
      <PageHeader
        title="Storage"
        description="Array, pools and disk health"
        actions={<SectionStatus section={data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }} />}
      />

      {error && !data && (
        <p role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm">
          Storage data unavailable: {error}
        </p>
      )}

      {loading && !data ? (
        <LoadingPanel rows={6} />
      ) : storage ? (
        <div className="space-y-4">
          {/* Hero: array verdict + capacity + warnings + live IO ---------------- */}
          <section aria-label="Array overview" className="rounded-xl border bg-card p-5 shadow-card">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-stretch">
              {/* Verdict */}
              <div className="min-w-0 lg:w-56 lg:shrink-0">
                <div className="flex items-center gap-2">
                  <HardDrive className="size-5 text-muted-foreground" aria-hidden="true" />
                  <h2 className="truncate text-lg font-semibold tracking-tight">
                    {arrayHealthLabel(storage.state)}
                  </h2>
                </div>
                <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <StatusDot tone={arrayTone} pulse={arrayTone === "critical"} />
                  {arrayTone === "healthy"
                    ? "All disks healthy"
                    : `${warnings.length} disk warning${warnings.length === 1 ? "" : "s"}${criticals.length > 0 ? ` · ${criticals.length} critical` : ""}`}
                </p>
                {storage.parityStatus && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Parity: {storage.parityStatus}
                    {storage.parityProgressPercent !== null && ` (${storage.parityProgressPercent}%)`}
                  </p>
                )}
              </div>

              {/* Capacity (data array + pools) */}
              <div className="min-w-0 flex-1 space-y-3">
                <div>
                  <div className="flex items-baseline justify-between gap-2">
                    <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      Usable capacity (data disks)
                    </dt>
                    <dd
                      className={cn(
                        "tnum text-sm font-semibold",
                        dataPercent !== null && dataPercent >= 90 && "text-danger",
                        dataPercent !== null && dataPercent >= 75 && dataPercent < 90 && "text-warning",
                      )}
                    >
                      {formatPercent(dataPercent, 0)} used
                    </dd>
                  </div>
                  <CapacityBar
                    className="mt-1.5"
                    segments={[{ percent: dataPercent ?? 0, className: utilizationToneClass(dataPercent), label: "used" }]}
                  />
                  <p className="tnum mt-1 text-xs text-muted-foreground">
                    {formatBytes(dataUsed)} used · {formatBytes(dataFree)} free · {formatBytes(dataTotal)} total
                  </p>
                </div>
                {cacheTotal > 0 && (
                  <div>
                    <div className="flex items-baseline justify-between gap-2">
                      <dt className="text-[11px] uppercase tracking-wider text-muted-foreground">Cache / pools</dt>
                      <dd className="tnum text-sm font-semibold">{formatPercent(cachePercent, 0)} used</dd>
                    </div>
                    <CapacityBar
                      className="mt-1.5"
                      segments={[{ percent: cachePercent ?? 0, className: utilizationToneClass(cachePercent), label: "cache used" }]}
                    />
                    <p className="tnum mt-1 text-xs text-muted-foreground">
                      {formatBytes(cacheUsed)} used · {formatBytes(cacheTotal)} total
                    </p>
                  </div>
                )}
              </div>

              {/* Warnings + live IO */}
              <div className="grid shrink-0 grid-cols-2 gap-5 lg:w-72 lg:grid-cols-1">
                <HeroStat
                  label="Active warnings"
                  value={`${warnings.length}`}
                  detail={
                    criticals.length > 0
                      ? `${criticals.length} critical: ${criticals.map((disk) => disk.name).join(", ")}`
                      : hotDisks.length > 0
                        ? `${hotDisks.length} disk(s) ≥45°C`
                        : warnings.length > 0
                          ? warnings.map((disk) => disk.name).join(", ")
                          : "clear"
                  }
                  tone={criticals.length > 0 ? "critical" : warnings.length > 0 || hotDisks.length > 0 ? "warning" : "healthy"}
                />
                <HeroStat
                  label="Disk I/O (live)"
                  value={formatRate(diskIoData?.totals.readBytesPerSec ?? null)}
                  detail={
                    <span className="inline-flex items-center gap-3">
                      <span className="inline-flex items-center gap-1">
                        <ArrowDownToLine className="size-3 text-info" aria-hidden="true" />
                        {formatRate(diskIoData?.totals.readBytesPerSec ?? null)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <ArrowUpFromLine className="size-3 text-warning" aria-hidden="true" />
                        {formatRate(diskIoData?.totals.writeBytesPerSec ?? null)}
                      </span>
                    </span>
                  }
                />
              </div>
            </div>
          </section>

          {/* Disks: unified health-first view ---------------------------------- */}
          <Card>
            <CardHeader className="gap-2">
              <CardTitle className="text-base">Disks</CardTitle>
              <span className="text-xs text-muted-foreground">{storage.disks.length} total</span>
            </CardHeader>
            <CardContent>
              {diskRows.length === 0 ? (
                <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No disks reported.
                </p>
              ) : (
                <>
                  {/* Desktop: health-first table with IO merged in */}
                  <div className="hidden md:block">
                    <table className="w-full text-sm">
                      <caption className="sr-only">Disks with health, capacity and live I/O</caption>
                      <thead>
                        <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                          <th scope="col" className="py-2 pr-3 font-medium">Disk</th>
                          <th scope="col" className="py-2 pr-3 font-medium">Role</th>
                          <th scope="col" className="py-2 pr-3 font-medium">Health</th>
                          <th scope="col" className="py-2 pr-3 font-medium">Utilization</th>
                          <th scope="col" className="py-2 pr-3 font-medium">Temp</th>
                          <th scope="col" className="py-2 pr-3 text-right font-medium">Read</th>
                          <th scope="col" className="py-2 text-right font-medium">Write</th>
                        </tr>
                      </thead>
                      <tbody>
                        {diskRows.map((row) => (
                          <tr key={`${row.disk.role}-${row.disk.name}`} className="border-b last:border-0 hover:bg-secondary/40">
                            <td className="py-2.5 pr-3">
                              <p className="font-medium">{row.disk.name}</p>
                              <p className="font-mono text-xs text-muted-foreground">{row.disk.device ?? "—"}</p>
                            </td>
                            <td className="py-2.5 pr-3">
                              <Badge variant="muted">{row.disk.role}</Badge>
                            </td>
                            <td className="py-2.5 pr-3">
                              <span className="inline-flex items-center gap-2">
                                <StatusDot tone={row.tone} />
                                {row.label}
                              </span>
                            </td>
                            <td className="w-48 py-2.5 pr-3">
                              {row.percent !== null ? (
                                <div className="flex items-center gap-2">
                                  <CapacityBar
                                    className="h-1.5 flex-1"
                                    segments={[
                                      { percent: row.percent, className: utilizationToneClass(row.percent), label: "used" },
                                    ]}
                                  />
                                  <span className="tnum w-10 text-right text-xs text-muted-foreground">
                                    {formatPercent(row.percent, 0)}
                                  </span>
                                  <span className="tnum hidden text-xs text-muted-foreground lg:inline">
                                    {formatBytes(row.disk.usedBytes)}
                                  </span>
                                </div>
                              ) : (
                                <span className="text-xs text-muted-foreground">
                                  {row.disk.role === "parity" ? "parity" : "—"}
                                </span>
                              )}
                            </td>
                            <td className="py-2.5 pr-3">
                              <DiskTemp tempC={row.disk.temperatureC} unit={tempUnit} />
                            </td>
                            <td className="tnum py-2.5 pr-3 text-right font-mono">{renderIoRead(row)}</td>
                            <td className="tnum py-2.5 text-right font-mono">{renderIoWrite(row)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile: health-first cards, no horizontal scroll */}
                  <div className="grid gap-2.5 md:hidden">
                    {diskRows.map((row) => (
                      <div key={`m-${row.disk.role}-${row.disk.name}`} className="rounded-lg border p-3">
                        <div className="flex items-center justify-between gap-2">
                          <span className="flex min-w-0 items-center gap-2">
                            <StatusDot tone={row.tone} />
                            <span className="truncate font-medium">{row.disk.name}</span>
                          </span>
                          <Badge variant="muted" className="text-[10px]">
                            {row.disk.role}
                          </Badge>
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">{row.label}</p>
                        <div className="mt-2">
                          <CapacityBar
                            segments={[
                              { percent: row.percent ?? 0, className: utilizationToneClass(row.percent), label: "used" },
                            ]}
                          />
                          <p className="tnum mt-1 flex justify-between text-xs text-muted-foreground">
                            <span>{row.percent !== null ? `${formatPercent(row.percent, 0)} used` : "no filesystem"}</span>
                            <span>
                              {row.disk.usedBytes !== null ? formatBytes(row.disk.usedBytes) : "—"} /{" "}
                              {row.disk.sizeBytes !== null ? formatBytes(row.disk.sizeBytes) : "—"}
                            </span>
                          </p>
                        </div>
                        <div className="tnum mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <Thermometer className="size-3" aria-hidden="true" />
                            <DiskTemp tempC={row.disk.temperatureC} unit={tempUnit} />
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <ArrowDownToLine className="size-3" aria-hidden="true" /> {renderIoRead(row)}
                          </span>
                          <span className="inline-flex items-center gap-1">
                            <ArrowUpFromLine className="size-3" aria-hidden="true" /> {renderIoWrite(row)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              <p className="mt-3 text-[11px] text-muted-foreground">
                Health reflects Unraid&apos;s disk color/state (healthy = ok). Live I/O matches disks to
                exporter devices by kernel name (sdX); the array layer (md) is excluded so member-disk and
                array I/O are never double-counted. SMART detail is not exposed by the Unraid GraphQL API.
              </p>
            </CardContent>
          </Card>

          {/* Performance history (Prometheus) ---------------------------------- */}
          <Card>
            <CardHeader className="gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <CardTitle className="mr-auto text-base">Performance history</CardTitle>
                <WindowPicker value={window} onChange={setWindow} options={["15m", "1h", "6h", "24h"]} />
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
                    <p className="mb-1 text-xs text-muted-foreground">Aggregate throughput</p>
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
                    <p className="mb-1 text-xs text-muted-foreground">Per-device throughput (top devices)</p>
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
        </div>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <HardDrive className="size-4" aria-hidden="true" /> Storage data unavailable.
        </p>
      )}
    </div>
  );
}
