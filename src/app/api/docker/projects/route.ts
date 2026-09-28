import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { listProjects } from "@/server/docker/project-service";

export const dynamic = "force-dynamic";

/**
 * Read-only compose project inventory (v0.7.13): every project with its
 * services, health, ownership and shared networks/volumes. Cheap join over
 * the cached managed inventory — no compose parsing on this path.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const force = url.searchParams.get("refresh") === "true";
  const payload = await listProjects(force);
  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}
