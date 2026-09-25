import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { checkForUpdate } from "@/server/actions/update-check";
import { getBuildInfo } from "@/server/version";

export const dynamic = "force-dynamic";

/** Current build vs latest GHCR semver tag (hourly cache, optional). */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const build = getBuildInfo();
  const check = await checkForUpdate();
  return NextResponse.json(
    { current: build.version, gitSha: build.gitSha, buildTime: build.buildTime, imageRef: build.imageRef, update: check },
    { headers: { "cache-control": "no-store" } },
  );
}
