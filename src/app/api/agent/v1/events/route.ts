import type { NextRequest } from "next/server";
import { requireAgent, agentJsonOk } from "@/server/agent/api";
import { recentTransitions } from "@/server/events/sampler";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = requireAgent(request, "events");
  if (denied) return denied;
  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50") || 50, 200);
  const since = url.searchParams.get("since") ?? "";
  const events = recentTransitions()
    .filter((transition) => !since || transition.at > since)
    .slice(0, limit)
    .map((transition) => ({
      eventId: `transition:${transition.name}:${transition.at}`,
      timestamp: transition.at,
      type: "docker.transition",
      data: { name: transition.name, from: transition.from, to: transition.to },
    }));
  return agentJsonOk({ events });
}
