import type { NextRequest } from "next/server";
import { requireAgent, agentJsonOk } from "@/server/agent/api";
import { loadBundle, buildDockerList } from "@/server/agent/snapshot";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = requireAgent(request, "docker");
  if (denied) return denied;
  return agentJsonOk({ containers: buildDockerList(await loadBundle()) });
}
