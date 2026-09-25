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
import { Button } from "@/components/ui/button";
import { formatBytes } from "@/lib/utils";
import { usePrefs, type HistoryWindowPref } from "@/lib/prefs";
import type { ResourceSample } from "@/lib/api-types";

const WINDOW_LABEL: Record<HistoryWindowPref, string> = {
  "5m": "5 min",
  "15m": "15 min",
  "1h": "1 hour",
};

function axisTickFormatter(time: number) {
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    name?: string;
    dataKey?: string | number;
    value?: number | string;
    color?: string;
  }>;
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
          <span className="text-muted-foreground">{entry.name}:</span>
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
  samples: ResourceSample[];
  window: HistoryWindowPref;
  windowFilled: boolean;
  totalSamples: number;
  loading: boolean;
}

export function ResourceChart({
  samples,
  window: windowPref,
  windowFilled,
  totalSamples,
  loading,
}: ResourceChartProps) {
  const { prefs, setPref } = usePrefs();

  return (
    <Card className="xl:col-span-2">
      <CardHeader>
        <CardTitle>Resource history</CardTitle>
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label="History time window"
        >
          {(Object.keys(WINDOW_LABEL) as HistoryWindowPref[]).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={prefs.historyWindow === option ? "secondary" : "ghost"}
              aria-pressed={prefs.historyWindow === option}
              onClick={() => setPref("historyWindow", option)}
              className="h-7 px-2.5 text-xs"
            >
              {WINDOW_LABEL[option]}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {loading && samples.length === 0 ? (
          <Skeleton className="h-[240px] w-full" />
        ) : samples.length < 2 ? (
          <div className="flex h-[240px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
            Collecting samples on the server — the chart fills in as the
            dashboard keeps polling.
          </div>
        ) : (
          <>
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={samples}
                  margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                >
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
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--color-border)"
                    vertical={false}
                  />
                  <XAxis
                    dataKey="time"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    tickFormatter={axisTickFormatter}
                    tick={{ fontSize: 11 }}
                    stroke="var(--color-muted-foreground)"
                    tickLine={false}
                    axisLine={false}
                    minTickGap={48}
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
                    strokeWidth={1.5}
                    isAnimationActive={false}
                    dot={false}
                  />
                  <Area
                    type="monotone"
                    dataKey="memory"
                    name="RAM %"
                    stroke="var(--color-chart-2)"
                    fill="url(#fillMem)"
                    strokeWidth={1.5}
                    isAnimationActive={false}
                    dot={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {totalSamples} samples in memory
              {" · "}
              {windowFilled
                ? `full ${WINDOW_LABEL[windowPref]} window`
                : `still filling the ${WINDOW_LABEL[windowPref]} window`}
              {" · "}
              tracked server-side, resets on container restart
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
