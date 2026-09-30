import { NextResponse } from "next/server";
import { areActionsEnabled, getEnv } from "@/server/env";
import {
  DOCKER_ACTIONS,
  NOTIFICATION_ACTIONS,
  VM_ACTIONS,
} from "@/server/actions/action-client";
import { guardRead } from "@/server/auth/guard";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/** Action capabilities (no secrets). UI disables controls accordingly. */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const enabled = areActionsEnabled();
  let reason: string | null = null;
  if (!enabled) {
    const env = getEnv();
    reason = env.ENABLE_ACTIONS
      ? "Action key is not configured (UNRAID_ACTION_API_KEY missing)."
      : "ENABLE_ACTIONS is not enabled.";
  }
  const env = getEnv();
  return NextResponse.json(
    {
      enabled,
      reason,
      docker: enabled ? [...DOCKER_ACTIONS] : [],
      vm: enabled ? [...VM_ACTIONS] : [],
      notification: enabled ? [...NOTIFICATION_ACTIONS] : [],
      cooldownMs: env.ACTION_COOLDOWN_MS,
      ratePerMinute: env.ACTION_RATE_PER_MINUTE,
      // v0.9.10: normalized per-action model (restart/pause always false —
      // the Unraid API exposes no such mutations). Consumers should prefer
      // this; the flat lists stay for backward compatibility.
      capabilities: {
        enabled,
        reason,
        docker: {
          enabled,
          start: enabled && DOCKER_ACTIONS.includes("start"),
          stop: enabled && DOCKER_ACTIONS.includes("stop"),
          restart: false,
          pause: false,
          unpause: false,
        },
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
