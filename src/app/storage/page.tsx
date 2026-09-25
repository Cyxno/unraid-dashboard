"use client";

import { HardDrive, Thermometer } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { PAGE_INTERVAL_MS, usePrefs } from "@/lib/prefs";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { SectionStatus } from "@/components/dashboard/section-status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatBytes, formatPercent, formatTemp, humanState } from "@/lib/utils";
import type { Section, StorageUsage } from "@/lib/api-types";

const COLOR_CLASS: Record<string, string> = {
  GREEN: "bg-success",
  YELLOW: "bg-warning",
  RED: "bg-destructive",
  RED_BALL: "bg-destructive",
  BLUE: "bg-blue-400",
  GREY: "bg-muted-foreground",
};

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
