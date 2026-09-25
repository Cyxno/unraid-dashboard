import { NextResponse } from "next/server";
import { guardRead } from "@/server/auth/guard";
import type { NextRequest } from "next/server";
import { getDiagnostics } from "@/server/metrics-service";

export const dynamic = "force-dynamic";

/**
 * Read-only diagnostics for the Settings page: data source health,
 * latencies, build provenance and per-section last-success times.
 * Never includes credentials — only target hostnames and latencies.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const payload = await getDiagnostics();
  return NextResponse.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
