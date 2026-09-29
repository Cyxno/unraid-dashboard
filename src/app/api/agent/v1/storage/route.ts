import type { NextRequest } from "next/server";
import { requireAgent, agentJsonOk, freshness } from "@/server/agent/api";
import { getOverview } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = requireAgent(request, "storage");
  if (denied) return denied;
  const overview = await getOverview("15m").catch(() => null);
  const storage = overview?.storage.data ?? null;
  return agentJsonOk({
    arrayState: storage?.state ?? null,
    parityStatus: storage?.parityStatus ?? null,
    capacity: storage
      ? { usedBytes: storage.usedBytes, freeBytes: storage.freeBytes, totalBytes: storage.totalBytes }
      : null,
    disks: (storage?.disks ?? []).map((disk) => ({
      name: disk.name,
      device: disk.device,
      role: disk.role,
      state: disk.state,
      fsColor: disk.fsColor,
      sizeBytes: disk.sizeBytes,
      usedBytes: disk.usedBytes,
      temperatureC: disk.temperatureC,
    })),
    freshness: freshness(overview ? new Date(overview.generatedAt).toISOString() : null, !overview, "Unraid API"),
  });
}
