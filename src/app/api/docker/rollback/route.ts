import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { recordAudit } from "@/server/actions/audit";
import { requestContainerRollback } from "@/server/update/helper-client";

export const dynamic = "force-dynamic";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** Rolls a container back to its helper-stored snapshot. Audited. */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "trusted-local";
  const rate = checkWriteRate(`container-rollback:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many rollback requests — slow down." },
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

  const startedAt = Date.now();
  const result = await requestContainerRollback(name);
  await recordAudit({
    actor, sourceIp: guard.sourceIp, kind: "update", action: "container-rollback",
    targetName: name, targetId: name,
    result: result.accepted ? "success" : "rejected",
    durationMs: Date.now() - startedAt,
    ...(result.reason && !result.accepted ? { error: result.reason } : {}),
  }).catch(() => {});

  if (!result.accepted) {
    return NextResponse.json(
      { error: result.reason ?? "Rollback request rejected." },
      { status: result.status, headers: { "cache-control": "no-store" } },
    );
  }
  return NextResponse.json(
    { accepted: true, name, phase: "requested" },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
