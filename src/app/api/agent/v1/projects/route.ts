import type { NextRequest } from "next/server";
import { requireAgent, agentJsonOk } from "@/server/agent/api";
import { listProjects } from "@/server/docker/project-service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const denied = requireAgent(request, "projects");
  if (denied) return denied;
  const { projects } = await listProjects();
  return agentJsonOk({ projects });
}
