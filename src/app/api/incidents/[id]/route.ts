import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { currentIncidentSnapshot } from "@/server/incidents/cycle";

export const dynamic = "force-dynamic";

/**
 * Incident detail (v1.5.0 Fase 22): what happened, evidence with source
 * + freshness, timeline, impact, notification status and a safe next
 * check. Id = the incident fingerprint (URL-encoded).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  const fingerprint = decodeURIComponent(id);
  if (fingerprint.length === 0 || fingerprint.length > 300) {
    return NextResponse.json(
      { error: "Invalid incident id." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const snapshot = currentIncidentSnapshot();
  const incident =
    snapshot.active.find((entry) => entry.id === fingerprint) ??
    snapshot.recovered.find((entry) => entry.id === fingerprint) ??
    null;
  if (!incident) {
    return NextResponse.json(
      { error: "Incident not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  const source = snapshot.sources.find((entry) => entry.source === incident.source) ?? null;
  return NextResponse.json(
    { incident, source, confidence: snapshot.confidence },
    { headers: { "cache-control": "no-store" } },
  );
}
