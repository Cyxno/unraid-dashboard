import { NextResponse, type NextRequest } from "next/server";
import { guardWrite, parseActionBody } from "@/server/auth/guard";
import { performAction } from "@/server/actions";
import {
  DOCKER_ACTIONS,
  NOTIFICATION_ACTIONS,
  VM_ACTIONS,
} from "@/server/actions/action-client";

export const dynamic = "force-dynamic";

/**
 * The single write endpoint. Allowlisted kinds/actions only, target must
 * exist in the live inventory, policy guards + audit apply, and the
 * whole subsystem is disabled unless ENABLE_ACTIONS + the action key
 * are configured.
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  const parsed = await parseActionBody(request);
  if (!parsed.ok) return parsed.response;
  const { kind, action, id } = parsed.body;

  // Static allowlist before anything else touches the request.
  const allowedActions: string[] =
    kind === "docker"
      ? [...DOCKER_ACTIONS]
      : kind === "vm"
        ? [...VM_ACTIONS]
        : [...NOTIFICATION_ACTIONS];
  if (!allowedActions.includes(action)) {
    return NextResponse.json(
      { ok: false, status: "rejected", message: `Unsupported action '${action}' for ${kind}.` },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const result = await performAction({
      actor: guard.identity.user ?? "local",
      sourceIp: guard.sourceIp,
      kind,
      action,
      targetId: id,
    });
    return NextResponse.json(result, {
      status: result.ok ? 200 : result.status === "rejected" ? 429 : 502,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("[api/actions] failed:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { ok: false, status: "error", message: "Action subsystem failure." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
