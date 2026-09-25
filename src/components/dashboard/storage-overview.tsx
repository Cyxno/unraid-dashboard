"use client";

import Link from "next/link";
import { HardDrive } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionStatus } from "./section-status";
import { cn, formatBytes, formatPercent, formatTemp, humanState } from "@/lib/utils";
import { usePrefs } from "@/lib/prefs";
import type { Section, StorageUsage } from "@/lib/api-types";

const ROLE_LABEL: Record<string, string> = {
  parity: "Parity",
  data: "Data",
  cache: "Cache",
  flash: "Flash",
};

const COLOR_CLASS: Record<string, string> = {
  GREEN: "bg-success",
  YELLOW: "bg-warning",
  RED: "bg-destructive",
  RED_BALL: "bg-destructive",
  BLUE: "bg-blue-400",
  GREY: "bg-muted-foreground",
};

export function StorageOverview({ storage }: { storage: Section<StorageUsage> }) {
  const { prefs } = usePrefs();
  const data = storage.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Storage
          {data && (
            <Badge variant={data.state === "STARTED" ? "success" : "warning"}>
              {humanState(data.state)}
            </Badge>
          )}
        </CardTitle>
        <SectionStatus section={storage} />
      </CardHeader>
      <CardContent className="space-y-3">
        {!data ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-1.5 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : (
          <>
            <div className="flex items-end justify-between gap-2">
              <p className="font-mono text-xl font-semibold tabular-nums">
                {formatBytes(data.usedBytes)}
                <span className="text-sm font-normal text-muted-foreground">
                  {" "}
                  of {formatBytes(data.totalBytes)}
                </span>
              </p>
              <span className="text-xs text-muted-foreground">
                {formatPercent(
                  data.totalBytes > 0 ? (data.usedBytes / data.totalBytes) * 100 : null,
                )}{" "}
                used
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{
                  width: `${
                    data.totalBytes > 0
                      ? Math.min(100, (data.usedBytes / data.totalBytes) * 100)
                      : 0
                  }%`,
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Parity: {humanState(data.parityStatus)}
              {data.parityProgressPercent !== null &&
                ` · ${data.parityProgressPercent}%`}
            </p>

            {data.disks.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                No disks reported.
              </p>
            ) : (
              <ul className="space-y-1">
                {data.disks.map((disk) => (
                  <li
                    key={`${disk.role}-${disk.name}`}
                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm hover:bg-secondary/50"
                  >
                    <HardDrive
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {disk.name}
                    </span>
                    <Badge variant="muted" className="text-[10px]">
                      {ROLE_LABEL[disk.role]}
                    </Badge>
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        disk.fsColor
                          ? (COLOR_CLASS[disk.fsColor] ?? "bg-muted-foreground")
                          : disk.state === "DISK_OK"
                            ? "bg-success"
                            : "bg-warning",
                      )}
                    />
                    <span className="sr-only">{humanState(disk.state)}</span>
                    <span className="w-28 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                      {disk.usedBytes !== null && disk.sizeBytes
                        ? `${formatBytes(disk.usedBytes, 0)} / ${formatBytes(disk.sizeBytes, 0)}`
                        : "—"}
                    </span>
                    <span className="hidden w-10 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground sm:inline">
                      {disk.temperatureC != null
                        ? formatTemp(disk.temperatureC, prefs.tempUnit)
                        : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="text-[11px] text-muted-foreground">
              <Link href="/storage" className="underline-offset-2 hover:underline">
                Full storage view
              </Link>
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
