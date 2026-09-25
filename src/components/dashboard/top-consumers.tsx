"use client";

import { Cpu, MemoryStick } from "lucide-react";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MetricStatus } from "./section-status";
import { formatBytes, formatPercent } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { TopConsumers } from "@/lib/api-types";

/**
 * "Top consumers" widget: top running containers by CPU% or absolute
 * memory, straight from Prometheus docker-stats gauges. Stopped
 * containers never appear (docker stats only reports running ones).
 */
export function TopConsumersCard({
  consumers,
}: {
  consumers: TopConsumers | null;
}) {
  const [tab, setTab] = useState<"cpu" | "memory">("cpu");

  const rows =
    consumers === null
      ? []
      : tab === "cpu"
        ? consumers.cpu.map((row) => ({
            name: row.name,
            value: row.percent,
            label: formatPercent(row.percent),
            percent: Math.min(100, row.percent ?? 0),
          }))
        : consumers.memory.map((row) => ({
            name: row.name,
            value: row.bytes,
            label: formatBytes(row.bytes),
            percent: null,
          }));

  const unavailable = consumers === null;

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-1">
          <CardTitle className="mr-auto text-base">Top consumers</CardTitle>
          {(
            [
              ["cpu", "CPU", Cpu],
              ["memory", "Memory", MemoryStick],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              type="button"
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
              className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
                tab === id
                  ? "bg-secondary font-medium"
                  : "text-muted-foreground hover:bg-secondary/50"
              }`}
            >
              <Icon className="size-3" aria-hidden="true" />
              {label}
            </button>
          ))}
        </div>
        {consumers && <MetricStatus meta={consumers.meta} />}
      </CardHeader>
      <CardContent>
        {unavailable ? (
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            Container metrics unavailable — Prometheus is unreachable.
          </p>
        ) : rows.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            No running containers reported.
          </p>
        ) : (
          <ol className="space-y-2">
            {rows.map((row, index) => (
              <li key={row.name} className="flex items-center gap-2 text-sm">
                <span
                  className="w-4 text-right font-mono text-xs text-muted-foreground"
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate" title={row.name}>
                  {row.name}
                </span>
                <div className="flex w-28 shrink-0 items-center gap-2">
                  {row.percent !== null && (
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          (row.percent ?? 0) >= 80
                            ? "bg-warning"
                            : "bg-primary",
                        )}
                        style={{ width: `${Math.max(2, row.percent ?? 0)}%` }}
                      />
                    </div>
                  )}
                  <span className="w-16 text-right font-mono text-xs tabular-nums">
                    {row.label}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}
