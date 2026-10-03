import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { resolveAuthMode, unraidConnectionConfigured } from "@/server/config/runtime";
import { loadConfig } from "@/server/config/store";
import { getHelperStatus } from "@/server/update/helper-client";
import { pushConfigured } from "@/server/notifications/push";

export const dynamic = "force-dynamic";

/** Security status for the Settings → Security card (no secrets). */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;

  const config = loadConfig();
  const authMode = resolveAuthMode();
  const helper = await getHelperStatus().catch(() => null);
  const push = pushConfigured();

  return NextResponse.json(
    {
      authMode: authMode.mode,
      authModeSource: authMode.source,
      localUsername: config.security.local?.username ?? null,
      localConfigured: config.security.local !== null,
      unraidConfigured: unraidConnectionConfigured(),
      unraidSource: process.env.UNRAID_URL ? "env" : config.unraid.url ? "ui" : "default",
      actionKeyConfigured: Boolean(process.env.UNRAID_ACTION_API_KEY),
      helperConfigured: helper?.configured ?? false,
      helperReachable: helper?.reachable ?? null,
      pushConfigured: push.configured,
      vapidConfigured: push.configured,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
