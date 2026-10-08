import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import type { EntityHistoryPayload, TrendRange } from "@/lib/api-types";
import { currentInsights, runInsightsCycle } from "@/server/insights/engine";
import { fetchAggregated } from "@/server/insights/prom-source";
import { escapePromQL } from "@/server/insights/engine-helpers";
import { loadIncidentsState } from "@/server/incidents/store";
import { readUpdateHistory } from "@/server/update/history";

export const dynamic = "force-dynamic";

/**
 * Entity history (v1.6.0 Fase 18): one bounded, server-aggregated view
 * per entity — CPU/memory trend, restarts, related incidents and notable
 * insights. Storage entities get usage history + growth + forecast.
 * No raw sample dumps; bucketed series only (Fase 19).
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const entity = (url.searchParams.get("entity") ?? "").slice(0, 120);
  const rangeParam = url.searchParams.get("window");
  const window: TrendRange = rangeParam === "24h" || rangeParam === "30d" ? rangeParam : "7d";
  if (!entity) {
    return NextResponse.json({ error: "entity required" }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  await runInsightsCycle();
  const insightsSnapshot = currentInsights();

  const isStorage = /^(cache|array|disk\d+|vm_storage)$/.test(entity);
  const selector = isStorage ? null : `name="${escapePromQL(entity)}"`;

  const [cpu, memory, restartChanges] = await Promise.all([
    selector
      ? fetchAggregated(`avg by () (rate(container_cpu_usage_seconds_total{${selector}}[10m])) * 100`, window)
      : Promise.resolve(null),
    selector ? fetchAggregated(`container_memory_working_set_bytes{${selector}}`, window) : Promise.resolve(null),
    selector
      ? fetchAggregated(`sum by () (changes(container_start_time_seconds{${selector}}[1h]))`, window)
      : Promise.resolve(null),
  ]);

  // Storage entity: usage-percent history + growth from the capacity model.
  let storagePayload: { usage: EntityHistoryPayload["cpuTrend"]; growth: EntityHistoryPayload["growth"] } | null = null;
  if (isStorage) {
    const mountpoint = entity === "cache" ? "/mnt/cache" : entity === "array" ? "/mnt/user" : entity === "vm_storage" ? "/mnt/vm_storage" : `/mnt/${entity}`;
    const [size, avail] = await Promise.all([
      fetchAggregated(`node_filesystem_size_bytes{mountpoint="${mountpoint}",fstype!=""}`, window),
      fetchAggregated(`node_filesystem_avail_bytes{mountpoint="${mountpoint}",fstype!=""}`, window),
    ]);
    const byTime = new Map(avail.samples.map((sample) => [sample.t, sample]));
    const usage = size.samples.map((sample) => {
      const availSample = byTime.get(sample.t);
      if (sample.value == null || !availSample || availSample.value == null || sample.value <= 0) {
        return { t: sample.t, value: null, quality: sample.quality === "missing" ? ("missing" as const) : sample.quality };
      }
      return {
        t: sample.t,
        value: ((sample.value - availSample.value) / sample.value) * 100,
        quality: sample.quality,
      };
    });
    const forecast = insightsSnapshot.forecasts.find((entry) => entry.entity === entity) ?? null;
    storagePayload = {
      usage,
      growth:
        forecast?.growthPerDay != null
          ? { perDayPercent: forecast.growthPerDay, perWeekPercent: forecast.growthPerWeek }
          : null,
    };
  }

  // Restarts: buckets where the change-counter rose become timestamps.
  const restarts: EntityHistoryPayload["restarts"] = [];
  if (restartChanges) {
    let previous = 0;
    for (const sample of restartChanges.samples) {
      const value = sample.value ?? 0;
      if (value > previous) {
        restarts.push({ at: sample.t, correlated: null });
      }
      previous = value;
    }
  }

  // Correlate restarts with update-machine runs (bounded lookup).
  const updates = await readUpdateHistory().catch(() => []);
  const entityUpdates = updates.filter((entry) => entry.target === entity).slice(0, 10);
  for (const restart of restarts) {
    const at = Date.parse(restart.at);
    const match = entityUpdates.find((entry) => Math.abs(Date.parse(entry.timestamp) - at) < 2 * 3600_000);
    if (match) restart.correlated = `update at ${match.timestamp.slice(0, 16).replace("T", " ")}`;
  }

  // Related incidents (bounded).
  const incidentsState = loadIncidentsState();
  const incidents = Object.values(incidentsState.incidents)
    .filter((incident) => incident.entity === entity)
    .slice(0, 10)
    .map((incident) => ({ id: incident.id, title: incident.title, firstSeenAt: incident.firstSeenAt, resolvedAt: incident.resolvedAt }));

  const insights = [
    ...insightsSnapshot.sections.watchSoon,
    ...insightsSnapshot.sections.trends,
    ...insightsSnapshot.sections.recurring,
  ].filter((insight) => insight.entity === entity || insight.id.includes(entity));

  const payload: EntityHistoryPayload = {
    entity,
    window,
    cpuTrend: cpu?.samples ?? [],
    memoryTrend: memory?.samples ?? [],
    restarts,
    incidents,
    insights: insights.slice(0, 6),
    forecast: insightsSnapshot.forecasts.find((entry) => entry.entity === entity) ?? null,
    growth: storagePayload?.growth ?? null,
  };
  // Storage entities expose their usage series in cpuTrend's slot? No —
  // honest shape: return usage under memoryTrend is wrong; keep a clear
  // contract by omitting cpu/memory for storage and letting the client
  // render `usage` from the dedicated field below.
  const body = isStorage ? { ...payload, usage: storagePayload?.usage ?? [] } : payload;
  return NextResponse.json(body, { headers: { "cache-control": "no-store" } });
}
