import type { NextRequest } from "next/server";
import { requireAgent, agentJsonOk } from "@/server/agent/api";
import { loadBundle, buildIssues } from "@/server/agent/snapshot";
import { getAutomationStatus } from "@/server/automation/status";
import { getHelperStatus } from "@/server/update/helper-client";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = requireAgent(request, "issues");
  if (denied) return denied;
  const [bundle, automation, helper] = await Promise.all([
    loadBundle(),
    getAutomationStatus().catch(() => null),
    getHelperStatus().catch(() => null),
  ]);
  const issues = buildIssues(
    bundle,
    {
      helperHealthy: helper?.reachable ?? null,
      paused: automation?.paused ?? false,
      enabled: automation?.enabled ?? false,
      queueLength: automation?.queue.length ?? 0,
      cooldownCount: automation?.targets.filter((target) => target.state === "cooldown").length ?? 0,
      interventionCount: automation?.targets.filter((target) => target.interventionRequired).length ?? 0,
    },
    /* registryVerified: the helper's pull probe is the pull-truth source. */
    helper?.pullAvailable === true,
  );
  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? "100") || 100, 500);
  return agentJsonOk({ issues: issues.slice(0, limit), total: issues.length });
}
