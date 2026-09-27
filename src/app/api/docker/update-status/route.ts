import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getContainerJob } from "@/server/update/helper-client";

export const dynamic = "force-dynamic";

/** Job status for one container (phases, result, stale detection). */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const name = request.nextUrl.searchParams.get("name") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) {
    return NextResponse.json(
      { error: "Invalid container name." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const job = await getContainerJob(name);
  return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
}
