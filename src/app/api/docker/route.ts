import { NextResponse } from "next/server";
import { getDockerWithMetrics } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

/**
 * Docker section with Prometheus runtime metrics joined by container
 * name. Lifecycle state stays live from Unraid even when Prometheus
 * is down (metrics carry their own status block).
 */
export async function GET() {
  const { section } = await getDockerWithMetrics();
  return NextResponse.json(section, {
    headers: { "cache-control": "no-store" },
  });
}
