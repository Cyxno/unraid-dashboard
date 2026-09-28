import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { projectPlan } from "@/server/docker/project-service";

export const dynamic = "force-dynamic";

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/**
 * Read-only update plan for one compose project (v0.7.13): safe order from
 * the configured depends_on graph, blocked services with reasons, rollback
 * readiness. No mutation path exists on this route.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const project = (url.searchParams.get("project") ?? "").trim();
  if (!PROJECT_RE.test(project)) {
    return NextResponse.json({ error: "Valid project name required." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const force = url.searchParams.get("refresh") === "true";
  const result = await projectPlan(project, force);
  if (!result.available) {
    return NextResponse.json({ error: result.reason }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
