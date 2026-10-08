import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { currentIncidentSnapshot } from "@/server/incidents/cycle";
import type { IncidentsPayload } from "@/lib/api-types";

export const dynamic = "force-dynamic";

/**
 * Incident Center feed (v1.5.0 Fase 21): active incidents, bounded
 * recently-recovered history, canonical source health and the overall
 * derived verdict. Read-only, no secrets.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const snapshot = currentIncidentSnapshot();
  const payload: IncidentsPayload = {
    active: snapshot.active,
    recovered: snapshot.recovered,
    counts: snapshot.counts,
    health: snapshot.health,
    sources: snapshot.sources,
    confidence: snapshot.confidence,
    evaluatedAt: snapshot.evaluatedAt ?? new Date().toISOString(),
  };
  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}
