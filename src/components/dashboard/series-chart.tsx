"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatBytes, formatRate } from "@/lib/utils";
import type { NamedSeries } from "@/lib/api-types";

/**
 * Chart for Prometheus-backed series. Handles gaps (null values break
 * the line instead of being drawn as zero), unit-aware axes and
 * tooltips, and disables animation to stay cheap on refreshes.
 */

export type SeriesUnit = "percent" | "bytes" | "rate" | "load" | "celsius" | "watts" | "iops" | "count";

export interface SeriesChartProps {
  /** Primary series drawn as filled areas. */
  series: NamedSeries[];
  /** Secondary series drawn as thin lines (e.g. per-core breakdown). */
  breakdown?: NamedSeries[];
  unit: SeriesUnit;
  height?: number;
  /** Colors from the chart palette, cycled per series. */
  maxSeries?: number;
  unavailable?: boolean;
  unavailableReason?: string;
}

const PALETTE = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

export function formatValue(value: number | null, unit: SeriesUnit): string {
  if (value === null || !Number.isFinite(value)) return "—";
  switch (unit) {
    case "percent":
      return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
    case "bytes":
      return formatBytes(value, 1);
    case "rate":
      return formatRate(value);
    case "celsius":
      return `${value.toFixed(1)}°C`;
    case "watts":
      return `${value.toFixed(1)} W`;
    case "iops":
      return `${value.toFixed(value >= 100 ? 0 : 1)} IOPS`;
    case "load":
      return value.toFixed(2);
    default:
      return value.toFixed(1);
  }
}

function axisLabel(unit: SeriesUnit): (value: number) => string {
  return (value: number) => {
    if (!Number.isFinite(value)) return "";
    switch (unit) {
      case "percent":
        return `${Math.round(value)}%`;
      case "rate":
        return `${formatBytes(value, 0)}/s`;
      case "bytes":
        return formatBytes(value, 0);
      case "celsius":
        return `${Math.round(value)}°`;
      case "watts":
        return `${Math.round(value)}W`;
      case "iops":
        return value >= 1000 ? `${Math.round(value / 1000)}k` : String(Math.round(value));
      case "load":
        return value.toFixed(1);
      default:
        return String(Math.round(value));
    }
  };
}

function timeTick(t: number): string {
  return new Date(t).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dayTick(t: number): string {
  return new Date(t).toLocaleDateString([], {
    weekday: "short",
    hour: "2-digit",
  });
}

interface ChartDatum extends Record<string, number | null> {
  t: number;
}

/** Interleaves named series into one row-per-timestamp dataset. */
function mergeSeries(seriesList: NamedSeries[], keys: string[]): ChartDatum[] {
  const byTime = new Map<number, ChartDatum>();
  seriesList.forEach((series, index) => {
    const key = keys[index] ?? `s${index}`;
    for (const point of series.points) {
      let row = byTime.get(point.t);
      if (!row) {
        row = { t: point.t };
        byTime.set(point.t, row);
      }
      row[key] = point.v;
    }
  });
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

function TooltipContent({
  active,
  payload,
  label,
  keys,
  names,
  unit,
}: {
  active?: boolean;
  payload?: Array<{ dataKey?: string | number; value?: number | string; color?: string }>;
  label?: number | string;
  keys: string[];
  names: Record<string, string>;
  unit: SeriesUnit;
}) {
  if (!active || !payload?.length) return null;
  const rows = payload.filter(
    (entry) =>
      typeof entry.value === "number" &&
      Number.isFinite(entry.value) &&
      keys.includes(String(entry.dataKey)),
  );
  if (rows.length === 0) return null;
  return (
    <div className="max-h-64 overflow-y-auto rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
      <p className="mb-1 font-medium">
        {(Number(label) % 86400000 > 0 && new Date(Number(label)).getHours() === 0
          ? dayTick(Number(label))
          : timeTick(Number(label)))}
      </p>
      {rows.map((entry) => (
        <p key={String(entry.dataKey)} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-muted-foreground">{names[String(entry.dataKey)]}</span>
          <span className="ml-auto font-mono tabular-nums">
            {formatValue(Number(entry.value), unit)}
          </span>
        </p>
      ))}
    </div>
  );
}

export function SeriesChart({
  series,
  breakdown = [],
  unit,
  height = 240,
  maxSeries = 8,
  unavailable = false,
  unavailableReason,
}: SeriesChartProps) {
  const chartSeries = useMemo(
    () => series.slice(0, maxSeries),
    [series, maxSeries],
  );
  const chartBreakdown = useMemo(
    () => breakdown.slice(0, maxSeries * 2),
    [breakdown, maxSeries],
  );

  const keys = useMemo(
    () => chartSeries.map((_, index) => `s${index}`),
    [chartSeries],
  );
  const breakdownKeys = useMemo(
    () => chartBreakdown.map((_, index) => `b${index}`),
    [chartBreakdown],
  );
  const allKeys = useMemo(
    () => [...keys, ...breakdownKeys],
    [keys, breakdownKeys],
  );
  const names = useMemo(() => {
    const map: Record<string, string> = {};
    chartSeries.forEach((series, index) => {
      map[`s${index}`] = series.name;
    });
    chartBreakdown.forEach((series, index) => {
      map[`b${index}`] = series.name;
    });
    return map;
  }, [chartSeries, chartBreakdown]);

  const data = useMemo(
    () => mergeSeries([...chartSeries, ...chartBreakdown], [...keys, ...breakdownKeys]),
    [chartSeries, chartBreakdown, keys, breakdownKeys],
  );

  const spanMs = data.length >= 2 ? data[data.length - 1]!.t - data[0]!.t : 0;
  const longRange = spanMs > 24 * 60 * 60 * 1000;

  if (unavailable) {
    return (
      <div
        className="flex items-center justify-center rounded-md border border-dashed px-6 text-center text-sm text-muted-foreground"
        style={{ height }}
      >
        {unavailableReason ?? "Series unavailable — Prometheus is unreachable."}
      </div>
    );
  }

  const hasData = data.length >= 2;

  return (
    <div style={{ height }}>
      {hasData ? (
        <ResponsiveContainer width="100%" height="100%">
          {chartBreakdown.length === 0 ? (
            <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                {keys.map((key, index) => (
                  <linearGradient key={key} id={`fill-${key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="5%"
                      stopColor={PALETTE[index % PALETTE.length]}
                      stopOpacity={0.3}
                    />
                    <stop
                      offset="95%"
                      stopColor={PALETTE[index % PALETTE.length]}
                      stopOpacity={0}
                    />
                  </linearGradient>
                ))}
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--color-border)"
                vertical={false}
              />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={longRange ? dayTick : timeTick}
                tick={{ fontSize: 11 }}
                stroke="var(--color-muted-foreground)"
                tickLine={false}
                axisLine={false}
                minTickGap={48}
              />
              <YAxis
                tickFormatter={axisLabel(unit)}
                width={52}
                tick={{ fontSize: 11 }}
                stroke="var(--color-muted-foreground)"
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                content={
                  <TooltipContent keys={keys} names={names} unit={unit} />
                }
              />
              {keys.map((key, index) => (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  name={names[key]}
                  stroke={PALETTE[index % PALETTE.length]}
                  fill={`url(#fill-${key})`}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                  dot={false}
                  activeDot={{ r: 2 }}
                  connectNulls={false}
                />
              ))}
            </AreaChart>
          ) : (
            <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--color-border)"
                vertical={false}
              />
              <XAxis
                dataKey="t"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickFormatter={longRange ? dayTick : timeTick}
                tick={{ fontSize: 11 }}
                stroke="var(--color-muted-foreground)"
                tickLine={false}
                axisLine={false}
                minTickGap={48}
              />
              <YAxis
                tickFormatter={axisLabel(unit)}
                width={52}
                tick={{ fontSize: 11 }}
                stroke="var(--color-muted-foreground)"
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                content={
                  <TooltipContent keys={allKeys} names={names} unit={unit} />
                }
              />
              {keys.map((key, index) => (
                <Area
                  key={key}
                  type="monotone"
                  dataKey={key}
                  name={names[key]}
                  stroke={PALETTE[index % PALETTE.length]}
                  fill={PALETTE[index % PALETTE.length]}
                  fillOpacity={0.15}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                  dot={false}
                  activeDot={{ r: 2 }}
                  connectNulls={false}
                />
              ))}
              {breakdownKeys.map((key, index) => (
                <Line
                  key={key}
                  type="monotone"
                  dataKey={key}
                  name={names[key]}
                  stroke={PALETTE[index % PALETTE.length]}
                  strokeWidth={0.75}
                  strokeOpacity={0.55}
                  isAnimationActive={false}
                  dot={false}
                  connectNulls={false}
                />
              ))}
            </LineChart>
          )}
        </ResponsiveContainer>
      ) : (
        <div
          className="flex items-center justify-center rounded-md border border-dashed px-6 text-center text-sm text-muted-foreground"
          style={{ height }}
        >
          Not enough data yet — the series fills as Prometheus keeps
          scraping.
        </div>
      )}
    </div>
  );
}
