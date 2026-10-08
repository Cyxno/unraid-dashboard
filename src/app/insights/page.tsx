"use client";

import { useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, Gauge, Minus, RefreshCw, Repeat2, Thermometer, Timer } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { EmptyPanel, ErrorPanel, LoadingPanel, PageHeader } from "@/components/dashboard/page-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { CapacityForecast, Confidence, InsightsPayload, Insight } from "@/lib/api-types";

/**
 * Operational Insights (v1.6.0 Fase 16): WATCH SOON / TRENDS / CAPACITY /
 * RECURRING / PERFORMANCE. Insights are NOT incidents — calm, bounded,
 * confidence-first. Deliberately few cards (Fase 30: scanbaarheid).
 */

const REFRESH_MS = 60_000;

const SEVERITY_STYLES: Record<Insight["severity"], string> = {
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  watch: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  info: "border-border bg-muted/40 text-muted-foreground",
};

const CONFIDENCE_TONE: Record<Confidence, string> = {
  high: "text-emerald-600 dark:text-emerald-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "text-orange-600 dark:text-orange-400",
  insufficient: "text-muted-foreground",
};

function ConfidenceLabel({ confidence }: { confidence: Confidence }) {
  return (
    <span className={cn("text-xs font-medium", CONFIDENCE_TONE[confidence])} title="Confidence derived from sample count, coverage, source health and variance">
      confidence: {confidence}
    </span>
  );
}

function InsightCard({ insight }: { insight: Insight }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3" data-testid={`insight-${insight.type}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", SEVERITY_STYLES[insight.severity])}>
          {insight.severity}
        </span>
        <span className="text-sm font-medium">{insight.title}</span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{insight.summary}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span>window {insight.window}</span>
        <ConfidenceLabel confidence={insight.confidence} />
        {insight.recommendation ? <span className="italic">· {insight.recommendation}</span> : null}
      </div>
    </div>
  );
}

function TrendArrow({ value }: { value: number | null }) {
  if (value == null) return <Minus className="size-3.5 text-muted-foreground" />;
  if (value > 0) return <ArrowUpRight className="size-3.5 text-red-500" />;
  if (value < 0) return <ArrowDownRight className="size-3.5 text-emerald-500" />;
  return <Minus className="size-3.5 text-muted-foreground" />;
}

function ForecastCard({ forecast }: { forecast: CapacityForecast }) {
  const insufficient = forecast.confidence === "insufficient" || forecast.summary === "no data for this mountpoint";
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3" data-testid={`forecast-${forecast.entity}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{forecast.label}</span>
        <span className="font-mono text-sm">{forecast.current != null ? `${Math.round(forecast.current)}%` : "—"}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <TrendArrow value={forecast.growthPerWeek} />
          {forecast.growthPerWeek != null ? `${forecast.growthPerWeek >= 0 ? "+" : ""}${forecast.growthPerWeek.toFixed(1)}%/week` : "no trend"}
        </span>
        <ConfidenceLabel confidence={forecast.confidence} />
      </div>
      <p className={cn("mt-1 text-sm", insufficient ? "text-muted-foreground/70" : "")}>{insufficient ? "Insufficient history — no forecast" : forecast.summary}</p>
    </div>
  );
}

const RANGES: Array<"24h" | "7d" | "30d"> = ["24h", "7d", "30d"];

export default function InsightsPage() {
  const { data, loading, error, ready, refresh } = usePoll<InsightsPayload>("/api/insights", REFRESH_MS);
  const [range, setRange] = useState<"24h" | "7d" | "30d">("7d");

  const rangeAvailable = data?.ranges.find((entry) => entry.range === range)?.available ?? true;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Operational Insights"
        description="Slow degradation, capacity and recurrence — estimates based on observed local history. Insights are not incidents."
        actions={
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        }
      />

      {!ready && loading ? (
        <LoadingPanel rows={5} />
      ) : error && !data ? (
        <ErrorPanel message={error} />
      ) : !data ? (
        <EmptyPanel message="No insights data yet." />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {RANGES.map((entry) => {
              const info = data.ranges.find((candidate) => candidate.range === entry);
              return (
                <Button
                  key={entry}
                  size="sm"
                  variant={range === entry ? "default" : "outline"}
                  onClick={() => setRange(entry)}
                  disabled={info ? !info.available : false}
                  title={info?.reason ?? undefined}
                >
                  {entry}
                </Button>
              );
            })}
            {!rangeAvailable ? <span className="text-xs text-muted-foreground">{data.ranges.find((entry) => entry.range === range)?.reason}</span> : null}
          </div>

          {data.sections.watchSoon.length > 0 ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <AlertTriangle className="size-4 text-amber-500" /> Watch soon
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {data.sections.watchSoon.map((insight) => (
                  <InsightCard key={insight.id} insight={insight} />
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Gauge className="size-4 text-muted-foreground" /> Capacity
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.forecasts.filter((forecast) => forecast.current != null).length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">No capacity data available.</p>
              ) : (
                data.forecasts
                  .filter((forecast) => forecast.current != null)
                  .slice(0, 6)
                  .map((forecast) => <ForecastCard key={forecast.entity} forecast={forecast} />)
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Thermometer className="size-4 text-muted-foreground" /> Trends
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.sections.trends.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">No notable trends in this window.</p>
              ) : (
                data.sections.trends.map((insight) => <InsightCard key={insight.id} insight={insight} />)
              )}
              {data.memoryCreep.length > 0 ? (
                <div className="rounded-lg border border-border/60 bg-card/40 p-3" data-testid="memory-creep">
                  {data.memoryCreep.map((creep) => (
                    <div key={creep.entity}>
                      <span className="text-sm font-medium">Memory creep: {creep.entity}</span>
                      <p className="mt-0.5 text-sm text-muted-foreground">{creep.summary}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                        <span>window {creep.window}</span>
                        <ConfidenceLabel confidence={creep.confidence} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Repeat2 className="size-4 text-muted-foreground" /> Recurring
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.sections.recurring.length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">Nothing recurring in this window.</p>
              ) : (
                data.sections.recurring.map((insight) => <InsightCard key={insight.id} insight={insight} />)
              )}
              {data.recurrence.filter((summary) => summary.occurrences7d > 0).length > 0 ? (
                <div className="rounded-md border border-border/40 p-2.5 text-xs text-muted-foreground" data-testid="recurrence-table">
                  <p className="mb-1 font-medium text-foreground/70">Incident history (7d)</p>
                  {data.recurrence
                    .filter((summary) => summary.occurrences7d > 0)
                    .slice(0, 5)
                    .map((summary) => (
                      <div key={`${summary.entity}-${summary.kind}`} className="flex flex-wrap justify-between gap-2 border-t border-border/30 py-1">
                        <span>
                          {summary.entity} · {summary.kind}
                        </span>
                        <span>
                          {summary.occurrences7d}× / 7d · total {Math.round(summary.totalActiveDurationMs / 60000)}m
                        </span>
                      </div>
                    ))}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Timer className="size-4 text-muted-foreground" /> Performance
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.sourcePerformance.filter((entry) => entry.sampleCount > 0).length === 0 ? (
                <p className="py-4 text-sm text-muted-foreground">Latency history is still accumulating (insufficient history).</p>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" data-testid="source-performance">
                  {data.sourcePerformance
                    .filter((entry) => entry.sampleCount > 0)
                    .slice(0, 6)
                    .map((entry) => (
                      <div key={entry.source} className="rounded-lg border border-border/60 bg-card/40 p-3">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium">{entry.source}</span>
                          <ConfidenceLabel confidence={entry.confidence} />
                        </div>
                        <p className="mt-1 font-mono text-xs text-muted-foreground">
                          p50 {entry.p50Ms != null ? `${entry.p50Ms}ms` : "—"} · p95 {entry.p95Ms != null ? `${entry.p95Ms}ms` : "—"} · n={entry.sampleCount}
                        </p>
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="outline">insights ≠ incidents</Badge>
            <span>Forecasts are estimates based on observed local history — never exact dates. Insights are not pushed unless you opt in.</span>
          </div>
        </>
      )}
    </div>
  );
}
