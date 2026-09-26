import { NextResponse, type NextRequest } from "next/server";
import { guardWrite, parseActionBody } from "@/server/auth/guard";
import { performAction } from "@/server/actions";
import { recordRequestId, seenRequestId } from "@/server/actions/policy";
import { isUpdatePhaseActive, getHelperStatus } from "@/server/update/helper-client";
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
 *
 * v0.7: lifecycle actions are refused while a dashboard update machine
 * is running (maintenance window) — no mutations during replace.
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  // Maintenance gate: refuse mutations during an in-app update.
  const helper = await getHelperStatus().catch(() => null);
  if (helper && isUpdatePhaseActive(helper.phase)) {
    return NextResponse.json(
      {
        ok: false,
        status: "rejected",
        message: `Dashboard update in progress (phase ${helper.phase}) — actions are temporarily disabled.`,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const parsed = await parseActionBody(request);
  if (!parsed.ok) return parsed.response;
  const { kind, action, id, requestId } = parsed.body;

  // Idempotency: a repeated requestId returns the recorded verdict
  // instead of executing the mutation again.
  if (requestId) {
    const seen = seenRequestId(requestId, kind, action, id);
    if (seen) {
      const cached = seen.result as { ok?: boolean; status?: string };
      return NextResponse.json(
        { ...(cached as object), duplicate: true },
        { status: cached.ok ? 200 : cached.status === "rejected" ? 429 : 502, headers: { "cache-control": "no-store" } },
      );
    }
  }

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
    if (requestId) {
      recordRequestId(requestId, kind, action, id, result);
    }
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
