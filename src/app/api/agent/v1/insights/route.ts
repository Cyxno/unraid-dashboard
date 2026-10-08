import type { NextRequest } from "next/server";
import { requireAgent, agentJsonOk } from "@/server/agent/api";
import { runInsightsCycle } from "@/server/insights/engine";

export const dynamic = "force-dynamic";

/**
 * Read-only machine insights (v1.6.0 Fase 27): compact — titles,
 * confidence, windows, forecasts. No writes, no raw sample dumps.
 */
export async function GET(request: NextRequest) {
  const denied = requireAgent(request, "insights");
  if (denied) return denied;
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const payload = refresh ? await runInsightsCycle(true) : await runInsightsCycle();
  return agentJsonOk({
    generatedAt: payload.generatedAt,
    counts: {
      watchSoon: payload.sections.watchSoon.length,
      trends: payload.sections.trends.length,
      capacity: payload.sections.capacity.length,
      recurring: payload.sections.recurring.length,
      performance: payload.sections.performance.length,
    },
    insights: [
      ...payload.sections.watchSoon,
      ...payload.sections.trends,
      ...payload.sections.capacity,
      ...payload.sections.recurring,
      ...payload.sections.performance,
    ].map((insight) => ({
      id: insight.id,
      entity: insight.entity,
      type: insight.type,
      severity: insight.severity,
      title: insight.title,
      summary: insight.summary,
      window: insight.window,
      confidence: insight.confidence,
      firstObserved: insight.firstObserved,
      actionable: insight.actionable,
    })),
    forecasts: payload.forecasts.map((forecast) => ({
      entity: forecast.entity,
      label: forecast.label,
      current: forecast.current,
      growthPerWeek: forecast.growthPerWeek,
      window: forecast.window,
      summary: forecast.summary,
      confidence: forecast.confidence,
      dataQuality: forecast.dataQuality,
    })),
    ranges: payload.ranges,
  });
}
