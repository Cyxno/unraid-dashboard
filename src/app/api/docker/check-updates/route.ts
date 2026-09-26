import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { updatesOverview } from "@/server/docker/updates";

export const dynamic = "force-dynamic";

/**
 * Forces a registry re-check for all container images. READ-ONLY with
 * respect to containers — registries are only HEAD-queried, images are
 * never pulled and containers are never touched. Guarded + rate-limited
 * (one refresh per minute per actor; the 4h per-image cache otherwise).
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "lan";
  const rate = checkWriteRate(`check-updates:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many refresh requests — results refresh automatically every few hours." },
      { status: 429, headers: { "cache-control": "no-store" } },
    );
  }
  const overview = await updatesOverview({ refresh: true });
  return NextResponse.json(
    {
      available: overview.available,
      checked: overview.containers.length,
      updatesFound: overview.containers.filter((container) => container.update_available).length,
      checkedAt: overview.checkedAt,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
