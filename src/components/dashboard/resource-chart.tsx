"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes } from "@/lib/utils";
import type { ResourceSample } from "@/server/unraid/types";

function axisTickFormatter(time: number) {
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TooltipContent({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name?: string; dataKey?: string | number; value?: number | string; color?: string }>;
  label?: number | string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium">{axisTickFormatter(Number(label))}</p>
      {payload.map((entry) => (
        <p key={String(entry.dataKey)} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="capitalize text-muted-foreground">{entry.name}:</span>
          <span className="font-mono tabular-nums">
            {entry.dataKey === "rx" || entry.dataKey === "tx"
              ? formatBytes(Number(entry.value), 0)
              : `${Number(entry.value).toFixed(1)}%`}
          </span>
        </p>
      ))}
    </div>
  );
}

interface ResourceChartProps {
  history: ResourceSample[];
  loading: boolean;
}

export function ResourceChart({ history, loading }: ResourceChartProps) {
  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <CardTitle>System resources</CardTitle>
        <p className="text-xs text-muted-foreground">
          Sampled live while this page is open
        </p>
      </CardHeader>
      <CardContent>
        {loading && history.length === 0 ? (
          <Skeleton className="h-[260px] w-full" />
        ) : history.length < 2 ? (
          <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
            Collecting samples — chart appears after a second refresh…
          </div>
        ) : (
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={history} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="fillCpu" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-chart-1)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--color-chart-1)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="fillMem" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-chart-2)" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="var(--color-chart-2)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
                <XAxis
                  dataKey="time"
                  tickFormatter={axisTickFormatter}
                  tick={{ fontSize: 11 }}
                  stroke="var(--color-muted-foreground)"
                  tickLine={false}
                  axisLine={false}
                  minTickGap={40}
                />
                <YAxis
                  domain={[0, 100]}
                  unit="%"
                  width={44}
                  tick={{ fontSize: 11 }}
                  stroke="var(--color-muted-foreground)"
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<TooltipContent />} />
                <Legend
                  wrapperStyle={{ fontSize: 12 }}
                  formatter={(value: string) => value.toUpperCase()}
                />
                <Area
                  type="monotone"
                  dataKey="cpu"
                  name="CPU %"
                  stroke="var(--color-chart-1)"
                  fill="url(#fillCpu)"
                  strokeWidth={2}
                  isAnimationActive={false}
                  dot={false}
                />
                <Area
                  type="monotone"
                  dataKey="memory"
                  name="Memory %"
                  stroke="var(--color-chart-2)"
                  fill="url(#fillMem)"
                  strokeWidth={2}
                  isAnimationActive={false}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
