import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { PromClient, isPrometheusConfigured } from "@/server/prometheus/client";
import { getThermalDiagnostics } from "@/server/prometheus/thermal";

export const dynamic = "force-dynamic";

/**
 * Thermal diagnostics v2 (24h): duration buckets, sustained episodes with
 * hysteresis, load/power correlation, hourly timeline. Definitions live in
 * server/prometheus/thermal.ts + thermal-diagnostics.ts; thresholds in
 * server/thresholds.ts. Unavailable when Prometheus is not configured.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  if (!isPrometheusConfigured()) {
    return NextResponse.json(
      { available: false, reason: "Prometheus is not configured." },
      { headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const diagnostics = await getThermalDiagnostics(new PromClient());
    return NextResponse.json(
      { available: true, diagnostics },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        available: false,
        reason: error instanceof Error ? error.message : "Thermal diagnostics failed.",
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
}
