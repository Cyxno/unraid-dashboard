import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { requestRollback, getHelperStatus, isUpdatePhaseActive } from "@/server/update/helper-client";
import { recordAudit } from "@/server/actions/audit";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { readUpdateHistory, validatedVersions } from "@/server/update/history";

export const dynamic = "force-dynamic";

const TAG_RE = /^\d+\.\d+\.\d+$/;

/**
 * Rollback to a previously validated release. The tag must be in the
 * validated list (persisted update history with a successful result AND
 * present locally); the helper re-validates the image label. Audited.
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  const actor = guard.identity.user ?? "lan";
  const rate = checkWriteRate(`rollback:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many rollback requests — slow down." },
      { status: 429, headers: { "cache-control": "no-store" } },
    );
  }

  let body: { tag?: unknown; confirm?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Malformed JSON body." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const tag = typeof body.tag === "string" ? body.tag.trim().replace(/^v/, "") : "";
  if (!TAG_RE.test(tag) || body.confirm !== "yes") {
    return NextResponse.json(
      { error: "A semantic version tag and explicit confirmation are required." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const helper = await getHelperStatus().catch(() => null);
  if (helper && isUpdatePhaseActive(helper.phase)) {
    return NextResponse.json(
      { error: `Update operation running (phase ${helper.phase}) — rollbacks are locked.` },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  // Validated-release allowlist: must appear in history as a successful run.
  const history = await readUpdateHistory().catch(() => []);
  const validated = validatedVersions(history);
  if (!validated.includes(tag)) {
    return NextResponse.json(
      {
        error: `Refusing rollback: ${tag} is not a validated release on this host (validated: ${validated.join(", ") || "none"}).`,
      },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const startedAt = Date.now();
  const result = await requestRollback(tag);
  await recordAudit({
    actor,
    sourceIp: guard.sourceIp,
    kind: "update",
    action: "rollback",
    targetName: "unraid-dashboard",
    targetId: tag,
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
    { accepted: true, tag, phase: "requested" },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
