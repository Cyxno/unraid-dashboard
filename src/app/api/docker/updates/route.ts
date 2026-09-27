import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { updatesOverview } from "@/server/docker/updates";
import { managedContainerSchema } from "@/server/docker/model";

export const dynamic = "force-dynamic";

/**
 * Central Docker update overview (Phase L, read-only): managed model for
 * every container + storage context. No mutation happens here — updates
 * dispatch later through the helper after policy gates.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const overview = await updatesOverview();  // eerste hit: sweep op de achtergrond
  if (!overview.available) {
    return NextResponse.json(overview, { headers: { "cache-control": "no-store" } });
  }
  // Validate output against the model schema — never leak raw inspect data.
  const containers = overview.containers.map((container) =>
    managedContainerSchema.safeParse(container),
  );
  const valid = containers
    .filter((result) => result.success)
    .map((result) => result.data);
  return NextResponse.json(
    {
      available: true,
      containers: valid,
      storage: overview.storage,
      checkedAt: overview.checkedAt,
      checking: overview.checking,
      pending: overview.pending,
      summary: {
        total: valid.length,
        updatesAvailable: valid.filter((container) => container.update_available).length,
        highRisk: valid.filter((container) => container.risk === "HIGH").length,
        manualPolicy: valid.filter((container) => container.policy === "manual").length,
        pinned: valid.filter((container) => container.update_status === "PINNED").length,
        localBuilds: valid.filter((container) => container.update_status === "LOCAL_BUILD").length,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
