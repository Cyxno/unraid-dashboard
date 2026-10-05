import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { loadConfig, saveConfig } from "@/server/config/store";

export const dynamic = "force-dynamic";

/**
 * Bumps the session epoch: every existing session token becomes invalid.
 * Used by "Sign out all devices" and after credential changes.
 * Requires the caller to already have a valid local session (enforced by
 * the proxy gate for local mode) or host-side access.
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  const config = loadConfig();
  if (config.security.mode !== "local" || !config.security.local) {
    return NextResponse.json({ error: "Local login is not enabled." }, { status: 404 });
  }
  config.security.sessionEpoch += 1;
  await saveConfig(config);
  return NextResponse.json({ ok: true, epoch: config.security.sessionEpoch }, { headers: { "cache-control": "no-store" } });
}
