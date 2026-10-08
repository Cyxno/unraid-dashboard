import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { currentInsights } from "@/server/insights/engine";

export const dynamic = "force-dynamic";

/** Single insight detail (v1.6.0 Fase 26): same bounded shape, by id. */
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
      { error: "Invalid insight id." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const snapshot = currentInsights();
  const all = [
    ...snapshot.sections.watchSoon,
    ...snapshot.sections.trends,
    ...snapshot.sections.capacity,
    ...snapshot.sections.recurring,
    ...snapshot.sections.performance,
  ];
  const insight = all.find((entry) => entry.id === fingerprint) ?? null;
  if (!insight) {
    return NextResponse.json(
      { error: "Insight not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  const forecast = snapshot.forecasts.find((entry) => entry.entity === insight.entity) ?? null;
  return NextResponse.json(
    { insight, forecast },
    { headers: { "cache-control": "no-store" } },
  );
}
