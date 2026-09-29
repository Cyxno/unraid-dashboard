import type { NextRequest } from "next/server";
import { requireAgent, agentJsonOk, AGENT_API_VERSION } from "@/server/agent/api";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = requireAgent(request, "capabilities");
  if (denied) return denied;
  return agentJsonOk({
    apiVersion: AGENT_API_VERSION,
    features: {
      summary: true,
      issues: true,
      docker: true,
      projects: true,
      storage: true,
      system: true,
      operations: true,
      events: true,
      stream: true,
      mutations: false,
    },
  });
}
