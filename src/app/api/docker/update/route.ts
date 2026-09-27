import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { recordAudit } from "@/server/actions/audit";
import {
  requestContainerUpdate,
  requestComposeUpdate,
  isUpdatePhaseActive,
  getHelperStatus,
} from "@/server/update/helper-client";
import { updatesOverview } from "@/server/docker/updates";
import { updateGate } from "@/server/docker/policy";

export const dynamic = "force-dynamic";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/**
 * Starts an update for ONE container through the helper's update machine.
 * Dispatches to the compose adapter for compose-managed containers and to
 * the generic machine otherwise. Dashboard gates on policy/blocks first;
 * the helper re-validates everything itself (compose labels, AIO/external
 * blocklist, locks). Audited with the real identity.
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "trusted-local";
  const rate = checkWriteRate(`container-update:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many update requests — slow down." },
      { status: 429, headers: { "cache-control": "no-store" } },
    );
  }

  let body: { name?: unknown; confirm?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Malformed JSON body." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!NAME_RE.test(name) || body.confirm !== "yes") {
    return NextResponse.json(
      { error: "A valid container name and explicit confirmation are required." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  // Dashboard-side gate: management type, risk, policy, blocks.
  const overview = await updatesOverview();
  const container = overview.containers.find((entry) => entry.name === name);
  if (!container) {
    return NextResponse.json(
      { error: "Container not found in inventory." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  const gate = updateGate(container);
  if (!gate.canUpdate) {
    await recordAudit({
      actor, sourceIp: guard.sourceIp, kind: "update", action: "container-update",
      targetName: name, targetId: container.image_id?.slice(0, 30) ?? name,
      result: "rejected", durationMs: 0,
      ...(gate.blockedReason ? { error: gate.blockedReason } : {}),
    }).catch(() => {});
    return NextResponse.json(
      { error: gate.blockedReason ?? "Updates are not permitted for this container." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }

  // Helper lock check before dispatch.
  const helper = await getHelperStatus().catch(() => null);
  if (helper?.reachable && isUpdatePhaseActive(helper.phase)) {
    return NextResponse.json(
      { error: `Update already running (phase ${helper.phase}).` },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  const startedAt = Date.now();
  // Dispatch: compose-managed → compose adapter, anders generiek machine.
  const isCompose = container.management_type === "compose";
  const result = isCompose
    ? await requestComposeUpdate(name)
    : await requestContainerUpdate(name);

  await recordAudit({
    actor, sourceIp: guard.sourceIp, kind: "update",
    action: isCompose ? "compose-update" : "container-update",
    targetName: name, targetId: container.current_digest?.slice(0, 30) ?? name,
    result: result.accepted ? "success" : "rejected",
    durationMs: Date.now() - startedAt,
    ...(result.reason && !result.accepted ? { error: result.reason } : {}),
  }).catch(() => {});

  if (!result.accepted) {
    return NextResponse.json(
      { error: result.reason ?? "Update request rejected." },
      { status: result.status, headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(
    { accepted: true, name, phase: "requested" },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
