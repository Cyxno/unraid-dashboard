"use client";

import Link from "next/link";
import { usePoll } from "@/hooks/use-poll";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { EntityHistoryPayload } from "@/lib/api-types";

/**
 * Operational history card (v1.6.0 Fase 18): bounded entity view —
 * restarts, related incidents and notable insights, all server-aggregated
 * (no raw sample dumps). Renders nothing when there is nothing to say.
 */

export function EntityInsights({ name }: { name: string }) {
  const history = usePoll<EntityHistoryPayload & { usage?: Array<{ t: string; value: number | null; quality: string }> }>(
    `/api/insights/entity?entity=${encodeURIComponent(name)}&window=7d`,
    300_000, // insights are TTL-cached server-side; 5 min client cadence
  );
  const data = history.data;
  if (!data) return null;
  const insights = data.insights ?? [];
  const restartCount = data.restarts?.length ?? 0;
  const incidentCount = data.incidents?.length ?? 0;
  if (insights.length === 0 && restartCount === 0 && incidentCount === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Operational history (7d)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {insights.map((insight) => (
          <div key={insight.id} className="rounded-md border border-border/50 p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className="text-[10px]">
                insight
              </Badge>
              <Link href={insight.deepLink} className="text-sm font-medium hover:underline">
                {insight.title}
              </Link>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {insight.summary} · confidence: {insight.confidence}
            </p>
          </div>
        ))}
        {restartCount > 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="entity-restarts">
            {restartCount} restart window{restartCount === 1 ? "" : "s"} detected in 7d
            {data.restarts.some((restart) => restart.correlated) ? " — correlated with updates" : ""}.
          </p>
        ) : null}
        {incidentCount > 0 ? (
          <p className="text-xs text-muted-foreground">
            {incidentCount} incident episode{incidentCount === 1 ? "" : "s"} on record — see the{" "}
            <Link href="/incidents" className="underline underline-offset-2">
              Incident Center
            </Link>
            .
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
