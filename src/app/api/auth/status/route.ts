import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { areActionsEnabled, getEnv } from "@/server/env";

export const dynamic = "force-dynamic";

/** Auth state for the UI (no secrets, no header names of secrets). */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const env = getEnv();
  const enabled = areActionsEnabled();
  return NextResponse.json(
    {
      mode: env.AUTH_MODE,
      user: guard.identity.user,
      actionsEnabled: enabled,
      actionsDisabledReason: enabled
        ? null
        : env.ENABLE_ACTIONS
          ? "Action key is not configured (UNRAID_ACTION_API_KEY missing)."
          : "ENABLE_ACTIONS is not enabled.",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
