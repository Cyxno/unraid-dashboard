import type { NextRequest } from "next/server";
import { requireAgent, agentJsonOk, freshness } from "@/server/agent/api";
import { getOverview } from "@/server/unraid/service";
import { getDiagnostics } from "@/server/metrics-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = requireAgent(request, "system");
  if (denied) return denied;
  const [overview, diagnostics] = await Promise.all([
    getOverview("15m").catch(() => null),
    getDiagnostics().catch(() => null),
  ]);
  return agentJsonOk({
    cpu: { percent: overview?.cpu.data?.percentTotal ?? null },
    memory: {
      percent: overview?.memory.data?.percentTotal ?? null,
      usedBytes: overview?.memory.data?.usedBytes ?? null,
      totalBytes: overview?.memory.data?.totalBytes ?? null,
      availableBytes: overview?.memory.data?.availableBytes ?? null,
    },
    load: {
      five: overview?.extras?.load?.five ?? null,
      fifteen: overview?.extras?.load?.fifteen ?? null,
    },
    temperatures: { packageC: overview?.extras?.thermal?.packageC ?? null },
    uptime: { seconds: overview?.identity.data?.uptimeSeconds ?? null },
    network: overview?.network.data
      ? { rxBytesPerSec: overview.network.data.rxBytesPerSec, txBytesPerSec: overview.network.data.txBytesPerSec }
      : null,
    dependencies: {
      unraid: diagnostics?.sources?.unraid?.reachable ?? null,
      prometheus: diagnostics?.sources?.prometheus?.reachable ?? null,
    },
    freshness: freshness(
      overview ? new Date(overview.generatedAt).toISOString() : null,
      !overview,
      "Unraid API + Prometheus",
    ),
  });
}
