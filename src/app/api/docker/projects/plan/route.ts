import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { planWithInvalidation } from "@/server/automation/project-registry";

export const dynamic = "force-dynamic";

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/**
 * Read-only update plan for one compose project (v0.7.13, registry-aware
 * since v0.8.0): safe order from the configured depends_on graph, blocked
 * services with reasons, rollback readiness. When the project's config
 * hash changed since the last plan, caches are invalidated and the plan
 * is freshly derived — a stale plan is never shown or executed.
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
  const result = await planWithInvalidation(project);
  if (!result.available) {
    const refreshed = force ? await import("@/server/docker/project-service").then((mod) => mod.projectPlan(project, true)) : result;
    if (!refreshed.available) {
      return NextResponse.json({ error: refreshed.reason }, { status: 503, headers: { "cache-control": "no-store" } });
    }
    return NextResponse.json(refreshed, { headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
}
