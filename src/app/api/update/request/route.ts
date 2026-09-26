import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { requestUpdate } from "@/server/update/helper-client";
import { recordAudit } from "@/server/actions/audit";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { setPendingUpdateRequest } from "@/server/update/history";

export const dynamic = "force-dynamic";

const TAG_RE = /^\d+\.\d+\.\d+$/;

/**
 * Requests an in-app update through the local helper. Guarded like every
 * write (auth + CSRF + rate limit) and audited with actor, versions,
 * result and duration. The helper enforces its own auth, tag allowlist,
 * single-flight lock, config preservation and rollback.
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  const actor = guard.identity.user ?? "lan";
  const rate = checkWriteRate(`update:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many update requests — slow down." },
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

  const tag = typeof body.tag === "string" ? body.tag.trim() : "";
  const startedAt = Date.now();
  if (!TAG_RE.test(tag) || body.confirm !== "yes") {
    return NextResponse.json(
      { error: "A semantic version tag and explicit confirmation are required." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const result = await requestUpdate(tag);
  await recordAudit({
    actor,
    sourceIp: guard.sourceIp,
    kind: "update",
    action: "request",
    targetName: "unraid-dashboard",
    targetId: tag,
    result: result.accepted ? "success" : result.attached ? "already-in-state" : "rejected",
    durationMs: Date.now() - startedAt,
    ...(result.reason && !result.attached ? { error: result.reason } : {}),
  }).catch(() => {});

  if (result.attached) {
    // Attach semantics: an operation is already running; the client
    // follows the status poll / SSE for its phases.
    return NextResponse.json(
      { attached: true, phase: result.phase ?? null },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }
  if (!result.accepted) {
    return NextResponse.json(
      { error: result.reason ?? "Update request rejected." },
      { status: result.status, headers: { "cache-control": "no-store" } },
    );
  }
  // Hand the real actor to the history reconciler.
  setPendingUpdateRequest(tag, actor);
  return NextResponse.json(
    { accepted: true, tag, phase: "requested" },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
