"use client";

import { Badge } from "@/components/ui/badge";
import { usePrefs } from "@/lib/prefs";
import { formatTemp } from "@/lib/utils";

export interface ThermalAnalysisPayload {
  available: boolean;
  reason?: string;
  warningC?: number;
  criticalC?: number;
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
      <p className="mt-2 text-[11px] text-muted-foreground">
        Sustained heat and momentary spikes are reported separately; this host
        exposes no throttle counters, so nothing here implies throttling.
      </p>
    </div>
  );
}
