import { HardDrive } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatBytes, formatPercent } from "@/lib/utils";
import type { StorageUsage } from "@/server/unraid/types";

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
  BLUE: "bg-blue-400",
  GREY: "bg-muted-foreground",
};

export function StorageOverview({ storage, loading }: { storage: StorageUsage | null; loading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage</CardTitle>
        {storage && (
          <Badge
            variant={
              storage.state === "STARTED"
                ? "success"
                : storage.state === "STOPPED"
                  ? "warning"
                  : "muted"
            }
          >
            {storage.state}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && !storage ? (
          <>
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-2 w-full" />
            <div className="space-y-2 pt-2">
              {[...Array(4)].map((_, index) => (
                <Skeleton key={index} className="h-9 w-full" />
              ))}
            </div>
          </>
        ) : storage ? (
          <>
            <div className="flex items-end justify-between gap-2">
              <p className="font-mono text-xl font-semibold tabular-nums">
                {formatBytes(storage.usedBytes)}
                <span className="text-sm font-normal text-muted-foreground">
                  {" "}of {formatBytes(storage.totalBytes)}
                </span>
              </p>
              <span className="text-xs text-muted-foreground">
                {formatPercent(
                  storage.totalBytes > 0
                    ? (storage.usedBytes / storage.totalBytes) * 100
                    : null,
                )}{" "}
                used
              </span>
            </div>
            <Progress
              value={
                storage.totalBytes > 0
                  ? (storage.usedBytes / storage.totalBytes) * 100
                  : 0
              }
            />
            <p className="text-xs text-muted-foreground">
              Parity: {storage.parityStatus.replaceAll("_", " ").toLowerCase()}
            </p>

            {storage.disks.length === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                No disks reported.
              </p>
            ) : (
              <ul className="space-y-1.5">
                {storage.disks.map((disk) => {
                  const percent =
                    disk.sizeBytes && disk.usedBytes !== null && disk.sizeBytes > 0
                      ? (disk.usedBytes / disk.sizeBytes) * 100
                      : null;
                  return (
                    <li
                      key={`${disk.role}-${disk.name}`}
                      className="flex items-center gap-3 rounded-md px-2 py-1.5 text-sm hover:bg-secondary/50"
                    >
                      <HardDrive className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate font-medium">{disk.name}</span>
                      <Badge variant="muted" className="text-[10px]">
                        {ROLE_LABEL[disk.role]}
                      </Badge>
                      <span
                        className={cn(
                          "hidden size-2 shrink-0 rounded-full sm:block",
                          disk.fsColor
                            ? (COLOR_CLASS[disk.fsColor] ?? "bg-muted-foreground")
                            : disk.state === "DISK_OK"
                              ? "bg-success"
                              : "bg-warning",
                        )}
                        title={disk.state}
                      />
                      <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {disk.usedBytes !== null && disk.sizeBytes
                          ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.sizeBytes)}`
                          : "—"}
                      </span>
                      <span className="hidden w-12 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground md:inline">
                        {disk.temperatureC != null ? `${disk.temperatureC}°C` : "—"}
                      </span>
                      <span className="sr-only">
                        {percent !== null ? `${percent.toFixed(0)} percent used` : "usage unavailable"}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">Storage data unavailable.</p>
        )}
      </CardContent>
    </Card>
  );
}
