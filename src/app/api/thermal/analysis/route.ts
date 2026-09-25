import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { PromClient, isPrometheusConfigured } from "@/server/prometheus/client";
import { getThermalAnalysis } from "@/server/prometheus/thermal";
import { CPU_TEMP_CRITICAL_C, CPU_TEMP_WARNING_C } from "@/server/thresholds";

export const dynamic = "force-dynamic";

/**
 * 24h thermal analysis (see server/prometheus/thermal.ts for the exact
 * definitions). Unavailable when Prometheus is not configured.
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
  const analysis = await getThermalAnalysis(
    new PromClient(),
    CPU_TEMP_WARNING_C,
    CPU_TEMP_CRITICAL_C,
  );
  return NextResponse.json(
    { available: true, warningC: CPU_TEMP_WARNING_C, criticalC: CPU_TEMP_CRITICAL_C, analysis },
    { headers: { "cache-control": "no-store" } },
  );
}
