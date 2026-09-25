import { NextResponse } from "next/server";
import { getBuildInfo } from "@/server/version";

/**
 * Runtime build provenance: app version, git SHA, build time, image ref.
 * Values are injected at Docker build time — nothing else from the
 * environment is ever exposed.
 */
export async function GET() {
  const info = getBuildInfo();
  return NextResponse.json(info, {
    headers: { "cache-control": "no-store" },
  });
}
