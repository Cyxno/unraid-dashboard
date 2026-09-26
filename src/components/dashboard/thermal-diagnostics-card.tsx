"use client";

import { useMemo } from "react";
import {
  Scatter,
  ScatterChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { Activity, Flame } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePrefs } from "@/lib/prefs";
import { formatPercent, formatTemp, formatWatts } from "@/lib/utils";

/**
 * Thermal diagnostics v2 (24h): duration buckets, sustained episodes,
 * load/power correlation, hourly timeline. All figures derive from
 * Prometheus range data; correlations are associative, never causal.
 */

export interface ThermalDiagnosticsPayload {
  available: boolean;
  reason?: string;
  diagnostics?: {
    meta: { status: string; reason?: string };
    thresholds: { warningC: number; criticalC: number };
    sensor: { name: string; chip: string } | null;
    currentC: number | null;
    averages: { avg5mC: number | null; avg15mC: number | null; avg1hC: number | null; avg24hC: number | null };
    maxima: { max1hC: number | null; max6hC: number | null; max24hC: number | null };
    median24hC: number | null;
    minutesAboveWarning: number | null;
    minutesAboveCritical: number | null;
    buckets: {
      labels: string[];
      counts: number[];
      coverageRatio: number | null;
      sampleCount: number;
    } | null;
    episodes: Array<{
      startMs: number;
      endMs: number | null;
      durationSeconds: number;
      maxC: number;
      avgC: number;
      avgCpuPercent: number | null;
      peakCpuPercent: number | null;
      avgPowerWatts: number | null;
      peakPowerWatts: number | null;
      tempVsCpu?: number | null;
      tempVsPower?: number | null;
      classification?: "load-correlated" | "power-correlated" | "weakly-correlated" | "unexplained";
      topContainers?: Array<{ name: string; avgCpuPercent: number; peakCpuPercent: number }>;
    }>;
    correlation: {
      tempVsCpu: number | null;
      tempVsCpuLabel: string;
      tempVsPower: number | null;
      tempVsPowerLabel: string;
      points: Array<{ t: number; tempC: number; cpuPercent: number; powerWatts: number | null }>;
      powerZone: "package-0" | "psys" | null;
    };
    timeline: Array<{ hourMs: number; maxC: number | null; avgC: number | null }>;
    peakPowerWatts24h: number | null;
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}

function formatHour(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function ThermalDiagnosticsCard({
  payload,
}: {
  payload: ThermalDiagnosticsPayload | null;
}) {
  const { prefs } = usePrefs();

  const bucketRows = useMemo(() => {
    const buckets = payload?.diagnostics?.buckets;
    if (!buckets || buckets.sampleCount === 0) return [];
    const total = buckets.sampleCount;
    return buckets.labels.map((label, index) => ({
      label,
      count: buckets.counts[index] ?? 0,
      percent: total > 0 ? Math.round(((buckets.counts[index] ?? 0) / total) * 1000) / 10 : 0,
    }));
  }, [payload]);

  const timeline = payload?.diagnostics?.timeline ?? [];
  const timelineMax = Math.max(95, ...timeline.map((hour) => hour.maxC ?? 0));
  const correlation = payload?.diagnostics?.correlation;
  const episodes = payload?.diagnostics?.episodes ?? [];

  if (!payload?.available || !payload.diagnostics) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Flame className="size-4 text-muted-foreground" aria-hidden="true" />
            Thermal diagnostics (24h)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-1">
          <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            {payload?.reason ?? "Thermal diagnostics unavailable."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const d = payload.diagnostics;
  const hoursAbove = (minutes: number | null) =>
    minutes === null ? "—" : minutes >= 60 ? `${(minutes / 60).toFixed(1)} h` : `${Math.round(minutes)} min`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Flame className="size-4 text-muted-foreground" aria-hidden="true" />
          Thermal diagnostics (24h)
          <Badge variant="muted">{d.sensor?.name ?? "package"}</Badge>
          {d.buckets && d.buckets.coverageRatio !== null && d.buckets.coverageRatio < 0.9 && (
            <Badge variant="warning" title="Prometheus has less than 90% of the window's samples">
              partial data ({Math.round(d.buckets.coverageRatio * 100)}%)
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 pt-1">
        {/* Stats */}
        <dl className="grid grid-cols-3 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-4">
          {(
            [
              ["Current", formatTemp(d.currentC, prefs.tempUnit)],
              ["5m avg", formatTemp(d.averages.avg5mC, prefs.tempUnit)],
              ["15m avg", formatTemp(d.averages.avg15mC, prefs.tempUnit)],
              ["1h avg", formatTemp(d.averages.avg1hC, prefs.tempUnit)],
              ["1h max", formatTemp(d.maxima.max1hC, prefs.tempUnit)],
              ["6h max", formatTemp(d.maxima.max6hC, prefs.tempUnit)],
              ["24h max", formatTemp(d.maxima.max24hC, prefs.tempUnit)],
              ["24h avg", formatTemp(d.averages.avg24hC, prefs.tempUnit)],
              ["24h median", formatTemp(d.median24hC, prefs.tempUnit)],
              [`≥${d.thresholds.warningC}°C`, hoursAbove(d.minutesAboveWarning)],
              [`≥${d.thresholds.criticalC}°C`, hoursAbove(d.minutesAboveCritical)],
              ["24h peak power", d.peakPowerWatts24h !== null ? formatWatts(d.peakPowerWatts24h) : "—"],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono">{value}</dd>
            </div>
          ))}
        </dl>

        {/* Duration buckets */}
        {bucketRows.length > 0 && (
          <section aria-label="Temperature duration buckets">
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Time distribution ({d.buckets?.sampleCount ?? 0} samples / 24h)
            </p>
            <div className="space-y-1">
              {bucketRows.map((row) => (
                <div key={row.label} className="flex items-center gap-2 text-xs">
                  <span className="w-16 shrink-0 text-muted-foreground">{row.label}</span>
                  <div className="h-3 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/70"
                      style={{ width: `${row.percent}%` }}
                    />
                  </div>
                  <span className="w-20 shrink-0 text-right font-mono tabular-nums">
                    {row.percent}%
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Episodes */}
        <section aria-label="Thermal episodes">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Episodes (sustained ≥{d.thresholds.warningC}°C for ≥5 min, ends &lt;{d.thresholds.warningC - 5}°C for 10 min)
          </p>
          {episodes.length === 0 ? (
            <p className="rounded-md border border-dashed p-2 text-center text-xs text-muted-foreground">
              No sustained episodes in the last 24h — momentary spikes are excluded by design.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2 font-medium">Start</th>
                    <th className="py-1 pr-2 font-medium">Duration</th>
                    <th className="py-1 pr-2 font-medium">Max</th>
                    <th className="py-1 pr-2 font-medium">CPU avg/peak</th>
                    <th className="py-1 pr-2 font-medium">Power avg</th>
                    <th className="py-1 pr-2 font-medium">Top containers</th>
                    <th className="py-1 font-medium">Pattern</th>
                  </tr>
                </thead>
                <tbody className="font-mono tabular-nums">
                  {episodes.slice(0, 8).map((episode) => (
                    <tr key={episode.startMs} className="border-t align-top">
                      <td className="py-1 pr-2">{formatHour(episode.startMs)}</td>
                      <td className="py-1 pr-2">
                        {formatDuration(episode.durationSeconds)}
                        {episode.endMs === null && " (ongoing)"}
                      </td>
                      <td className="py-1 pr-2">{formatTemp(episode.maxC, prefs.tempUnit)}</td>
                      <td className="py-1 pr-2">
                        {episode.avgCpuPercent !== null
                          ? `${formatPercent(episode.avgCpuPercent)} / ${formatPercent(episode.peakCpuPercent)}`
                          : "—"}
                      </td>
                      <td className="py-1 pr-2">
                        {episode.avgPowerWatts !== null ? formatWatts(episode.avgPowerWatts) : "—"}
                      </td>
                      <td className="max-w-[180px] py-1 pr-2 font-sans text-[11px]">
                        {episode.topContainers && episode.topContainers.length > 0 ? (
                          <span className="block truncate" title={episode.topContainers.map((c) => `${c.name} (${c.avgCpuPercent}%)`).join(", ")}>
                            {episode.topContainers.map((c) => c.name).join(", ")}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">no per-container data</span>
                        )}
                      </td>
                      <td className="py-1 font-sans">
                        <Badge
                          variant={
                            episode.classification === "load-correlated"
                              ? "warning"
                              : episode.classification === "unexplained"
                                ? "muted"
                                : "secondary"
                          }
                          className="text-[10px]"
                        >
                          {episode.classification ?? "—"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* Correlation */}
        <section aria-label="Load correlation">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Activity className="size-3.5" aria-hidden="true" />
            Load correlation
          </p>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
            <p>
              <span className="text-muted-foreground">temp ↔ CPU: </span>
              <span className="font-mono">{d.correlation.tempVsCpu?.toFixed(2) ?? "—"}</span>{" "}
              <Badge variant="muted">{d.correlation.tempVsCpuLabel}</Badge>
            </p>
            <p>
              <span className="text-muted-foreground">
                temp ↔ {d.correlation.powerZone === "package-0" ? "CPU power" : "system power"}:{" "}
              </span>
              <span className="font-mono">{d.correlation.tempVsPower?.toFixed(2) ?? "—"}</span>{" "}
              <Badge variant="muted">{d.correlation.tempVsPowerLabel}</Badge>
            </p>
          </div>
          {correlation && correlation.points.length > 10 && (
            <div className="mt-2 h-48 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
                  <XAxis
                    type="number"
                    dataKey="cpuPercent"
                    name="CPU %"
                    domain={[0, 100]}
                    tick={{ fontSize: 10 }}
                    label={{ value: "CPU %", position: "insideBottom", offset: -8, fontSize: 10 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="tempC"
                    name="°C"
                    domain={["dataMin - 2", "dataMax + 2"]}
                    tick={{ fontSize: 10 }}
                    width={36}
                  />
                  <ZAxis range={[24, 24]} />
                  <Tooltip
                    cursor={{ strokeDasharray: "3 3" }}
                    contentStyle={{ fontSize: 11, background: "var(--background)", border: "1px solid var(--border)" }}
                    formatter={(value, name) =>
                      name === "CPU %"
                        ? `${Number(value).toFixed(1)}%`
                        : `${Number(value).toFixed(1)}°C`
                    }
                    labelFormatter={() => ""}
                  />
                  <Scatter data={correlation.points} fill="var(--color-chart-1)" fillOpacity={0.55} />
                </ScatterChart>
              </ResponsiveContainer>
              <p className="mt-1 text-center text-[10px] text-muted-foreground">
                package temp vs CPU% over 24h (5-min spacing) — associative, not causal
              </p>
            </div>
          )}
        </section>

        {/* Timeline */}
        {timeline.length > 3 && (
          <section aria-label="24h thermal timeline">
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              24h hourly maxima
            </p>
            <div className="flex h-16 items-end gap-[2px]">
              {timeline.map((hour) => {
                const maxC = hour.maxC ?? 0;
                const height = Math.max(4, Math.round((maxC / timelineMax) * 100));
                const hot = maxC >= d.thresholds.warningC;
                const critical = maxC >= d.thresholds.criticalC;
                return (
                  <div
                    key={hour.hourMs}
                    title={`${formatHour(hour.hourMs)} · max ${formatTemp(hour.maxC, prefs.tempUnit)} · avg ${formatTemp(hour.avgC, prefs.tempUnit)}`}
                    className="min-w-[3px] flex-1 rounded-t"
                    style={{
                      height: `${height}%`,
                      backgroundColor: critical
                        ? "var(--color-destructive)"
                        : hot
                          ? "var(--color-warning)"
                          : "var(--color-chart-1)",
                      opacity: 0.8,
                    }}
                  />
                );
              })}
            </div>
            <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
              <span>{timeline.length > 0 ? formatHour(timeline[0]!.hourMs) : ""}</span>
              <span>now</span>
            </div>
          </section>
        )}

        <p className="text-[11px] text-muted-foreground">
          Buckets, episodes and correlations are computed from actual Prometheus range data
          (60s step, 24h). Power uses the RAPL <code>{d.correlation.powerZone ?? "n/a"}</code> zone.
          Episode patterns follow documented rules (avg CPU ≥50% or r≥0.5 → load/power-correlated;
          both &lt;0.3 → unexplained) and are associative — never causal. &quot;Top containers&quot; come from
          name-keyed container CPU history and are omitted entirely when no data exists. This host
          exposes no throttle counters, so throttling is never claimed.
        </p>
      </CardContent>
    </Card>
  );
}
