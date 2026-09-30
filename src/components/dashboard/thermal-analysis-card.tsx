"use client";

import { Badge } from "@/components/ui/badge";
import { usePrefs } from "@/lib/prefs";
import { formatTemp } from "@/lib/utils";

export interface ThermalAnalysisPayload {
  available: boolean;
  reason?: string;
  warningC?: number;
  criticalC?: number;
  context7d?: {
    available: boolean;
    reason?: string;
    avg7dC: number | null;
    max7dC: number | null;
    dailyMeanC: Array<{ day: string; avgC: number | null }>;
    daysWithObservations: number;
    slopeCPerDay: number | null;
    slopeMethod: string;
    episodes: { aboveWarning: number; aboveCritical: number };
    samples: number;
  };
  analysis?: {
    sensor: { name: string; chip: string } | null;
    currentC: number | null;
    avg5mC: number | null;
    max1hC: number | null;
    max24hC: number | null;
    avg24hC: number | null;
    median24hC: number | null;
    minutesAboveWarning: number | null;
    minutesAboveCritical: number | null;
    state: string;
    explanation: string;
  };
}

/**
 * 24h thermal analysis: aggregates + time-above-threshold with an
 * explicit spike-vs-sustained distinction (no throttling claims).
 */
export function ThermalAnalysisCard({
  payload,
}: {
  payload: ThermalAnalysisPayload | null;
}) {
  const { prefs } = usePrefs();
  if (!payload?.available || !payload.analysis) {
    return (
      <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
        {payload?.reason ?? "24h thermal analysis unavailable."}
      </p>
    );
  }
  const a = payload.analysis;
  const hoursAbove = (minutes: number | null) =>
    minutes === null
      ? "—"
      : minutes >= 60
        ? `${(minutes / 60).toFixed(1)} h`
        : `${Math.round(minutes)} min`;

  const stateVariant =
    a.state === "critical" || a.state === "sustained-high"
      ? "destructive"
      : a.state === "spike" || a.state === "elevated"
        ? "warning"
        : "success";

  return (
    <div className="rounded-md border p-3">
      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
        24h thermal analysis
        <Badge variant={stateVariant}>{a.state}</Badge>
        <span className="text-xs font-normal text-muted-foreground">
          {a.sensor?.name}
        </span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{a.explanation}</p>
      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
        {(
          [
            ["Current", formatTemp(a.currentC, prefs.tempUnit)],
            ["5m avg", formatTemp(a.avg5mC, prefs.tempUnit)],
            ["1h max", formatTemp(a.max1hC, prefs.tempUnit)],
            ["24h max", formatTemp(a.max24hC, prefs.tempUnit)],
            ["24h median", formatTemp(a.median24hC, prefs.tempUnit)],
            ["24h avg", formatTemp(a.avg24hC, prefs.tempUnit)],
            [`≥ ${payload.warningC}°C (24h)`, hoursAbove(a.minutesAboveWarning)],
            [`≥ ${payload.criticalC}°C (24h)`, hoursAbove(a.minutesAboveCritical)],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="flex justify-between gap-2">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono">{value}</dd>
          </div>
        ))}
      </dl>

      {/* 7-day context (v0.9.10): answers "consistently hot, or was today
          unusual?" — facts only (averages, max, sustained episodes, and a
          clearly-defined daily slope when ≥5 days of data exist). */}
      {payload.context7d && (payload.context7d.available ? (
        <div className="mt-3 border-t pt-2">
          <p className="text-xs font-medium">7-day context</p>
          <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs sm:grid-cols-3">
            {(
              [
                ["7d avg", formatTemp(payload.context7d.avg7dC, prefs.tempUnit)],
                ["7d max", formatTemp(payload.context7d.max7dC, prefs.tempUnit)],
                [`Sustained > ${payload.warningC}°C episodes (7d)`, String(payload.context7d.episodes.aboveWarning)],
                [`Sustained > ${payload.criticalC}°C episodes (7d)`, String(payload.context7d.episodes.aboveCritical)],
                [
                  "7-day slope",
                  payload.context7d.slopeCPerDay !== null
                    ? `${payload.context7d.slopeCPerDay > 0 ? "+" : ""}${payload.context7d.slopeCPerDay} °C/day`
                    : "not enough data",
                ],
                ["Days observed", `${payload.context7d.daysWithObservations}/7`],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="flex justify-between gap-2">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-mono">{value}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2 flex flex-wrap items-end gap-1" aria-hidden="true">
            {payload.context7d.dailyMeanC.map((day) => {
              const means = payload.context7d!.dailyMeanC.map((d) => d.avgC).filter((v): v is number => v !== null);
              const max = means.length > 0 ? Math.max(...means) : 0;
              const min = means.length > 0 ? Math.min(...means) : 0;
              const height = day.avgC === null || max === min ? 4 : 4 + ((day.avgC - min) / (max - min)) * 20;
              return (
                <span
                  key={day.day}
                  title={`${day.day}: ${day.avgC !== null ? `${day.avgC}°C avg` : "no data"}`}
                  className="w-6 rounded-sm bg-primary/40"
                  style={{ height: `${height}px` }}
                />
              );
            })}
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Daily means, oldest first
            {payload.context7d.slopeCPerDay !== null
              ? ` · slope = ${payload.context7d.slopeMethod}`
              : " · slope computed only from ≥5 observed days (no trend is claimed)"}
            .
          </p>
        </div>
      ) : (
        <p className="mt-3 border-t pt-2 text-[11px] text-muted-foreground">
          7-day context unavailable — {payload.context7d.reason ?? "no history"}.
        </p>
      ))}

      <p className="mt-2 text-[11px] text-muted-foreground">
        Sustained heat and momentary spikes are reported separately; this host
        exposes no throttle counters, so nothing here implies throttling.
      </p>
    </div>
  );
}
