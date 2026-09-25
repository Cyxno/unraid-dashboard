import { NextResponse } from "next/server";
import { guardRead } from "@/server/auth/guard";
import type { NextRequest } from "next/server";
import { getBuildInfo } from "@/server/version";

/**
 * Runtime build provenance: app version, git SHA, build time, image ref.
 * Values are injected at Docker build time — nothing else from the
 * environment is ever exposed.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const info = getBuildInfo();
  return NextResponse.json(info, {
    headers: { "cache-control": "no-store" },
  });
}
