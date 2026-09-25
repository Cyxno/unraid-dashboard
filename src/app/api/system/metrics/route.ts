import { NextResponse } from "next/server";
import { guardRead } from "@/server/auth/guard";
import type { NextRequest } from "next/server";
import { getSystemMetrics } from "@/server/metrics-service";

export const dynamic = "force-dynamic";

/**
 * Instant Prometheus-backed system snapshot (CPU, per-core, load,
 * memory breakdown, thermals). Marks itself unavailable/stale when
 * Prometheus is down — never falls back to fabricated values.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const payload = await getSystemMetrics();
  return NextResponse.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
