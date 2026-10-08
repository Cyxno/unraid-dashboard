import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { runInsightsCycle } from "@/server/insights/engine";

export const dynamic = "force-dynamic";

/**
 * Operational insights (v1.6.0 Fase 26): read-only, cached snapshot.
 * The cycle itself is TTL-gated (2 min minimum, range queries cached
 * 5–60 min) so polling this route never causes a query storm. Pass
 * `refresh=1` to force an out-of-band cycle (still single-flight and
 * min-interval-guarded).
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  const payload = refresh ? await runInsightsCycle(true) : await runInsightsCycle();
  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}
