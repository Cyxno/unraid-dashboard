import type { NextRequest } from "next/server";
import { requireAgent, agentJsonOk, freshness } from "@/server/agent/api";
import { getAutomationStatus } from "@/server/automation/status";
import { listBackups } from "@/server/resilience/backup";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = requireAgent(request, "operations");
  if (denied) return denied;
  const [automation, backups] = await Promise.all([
    getAutomationStatus().catch(() => null),
    listBackups().catch(() => []),
  ]);
  return agentJsonOk({
    updateHelper: {
      reachable: automation?.infrastructure.helperHealthy ?? null,
    },
    automation: automation
      ? {
          enabled: automation.enabled,
          paused: automation.paused,
          queueLength: automation.queue.length,
          cooldownCount: automation.targets.filter((target) => target.state === "cooldown").length,
          interventionCount: automation.targets.filter((target) => target.interventionRequired).length,
          lastTickAt: automation.scheduler.lastTickAt,
        }
      : null,
    backups: { count: backups.length, latest: backups[0] ?? null },
    freshness: freshness(new Date().toISOString(), false, "Beacon"),
  });
}
