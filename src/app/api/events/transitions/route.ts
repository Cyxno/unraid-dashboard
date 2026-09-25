import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { recentTransitions } from "@/server/events/sampler";

export const dynamic = "force-dynamic";

/**
 * Recently observed container state transitions (bounded, in-memory).
 * These are OBSERVATIONS from sampling — not dashboard actions — and the
 * UI labels them accordingly.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  return NextResponse.json(
    { transitions: recentTransitions() },
    { headers: { "cache-control": "no-store" } },
  );
}
