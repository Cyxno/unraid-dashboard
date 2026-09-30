import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { updatesSummaryFromCache } from "@/server/docker/updates";

export const dynamic = "force-dynamic";

/**
 * Lightweight update awareness (v0.9.9): serves ONLY cached state —
 * last check time, known update count, checking/stale flags. Never
 * triggers the registry sweep, never contacts the registry, never
 * blocks the Docker page. The full sweep happens exclusively when the
 * Updates section is expanded or Check is pressed.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  return NextResponse.json(updatesSummaryFromCache(), {
    headers: { "cache-control": "no-store" },
  });
}
