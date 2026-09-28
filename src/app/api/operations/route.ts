import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getOperationsStatus } from "@/server/operations/status";

export const dynamic = "force-dynamic";

/**
 * Read-only Operations status (v0.7.13): the aggregate behind the
 * operator's "what is broken?" page. Exposes health/latency verdicts and
 * timestamps only — never tokens, env values or snapshot contents.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const status = await getOperationsStatus();
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}
