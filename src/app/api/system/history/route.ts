import { NextResponse, type NextRequest } from "next/server";
import { getSystemHistoryPayload } from "@/server/metrics-service";
import { parseWindow } from "@/server/prometheus/windows";
import type { SystemHistoryMetric } from "@/lib/api-types";

export const dynamic = "force-dynamic";

const METRICS = new Set<SystemHistoryMetric>([
  "cpu",
  "memory",
  "load",
  "network",
  "disk",
  "temps",
]);

/**
 * Prometheus-backed history for one system metric family. Only the
 * enum metric + window parameters are accepted — the PromQL lives
 * server-side and is never supplied by the browser.
 */
export async function GET(request: NextRequest) {
  const metricParam = request.nextUrl.searchParams.get("metric") ?? "cpu";
  const metric = (METRICS as Set<string>).has(metricParam)
    ? (metricParam as SystemHistoryMetric)
    : "cpu";
  const window = parseWindow(request.nextUrl.searchParams.get("window"));
  const payload = await getSystemHistoryPayload(metric, window);
  return NextResponse.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
