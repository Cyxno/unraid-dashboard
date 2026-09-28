import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { recordAudit } from "@/server/actions/audit";
import { acknowledgeTarget, cancelQueuedJob, runOnce, setTargetOptIn } from "@/server/automation/status";

export const dynamic = "force-dynamic";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/**
 * Automation target/queue actions (v0.8.0):
 *   {action: "opt-in",  name, optIn}   per-container pilot opt-in/out
 *   {action: "ack",     name}          acknowledge cooldown/intervention
 *   {action: "cancel",  id}            cancel one queued auto job
 *   {action: "run-once"}               supervised scheduler tick (same gates)
 *
 * The browser can NEVER make an ineligible target eligible: eligibility is
 * re-derived server-side on every tick; these actions only change
 * operator intent (opt-in/ack/cancel) or trigger an evaluation.
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "trusted-local";
  const rate = checkWriteRate(`automation-action:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json({ error: "Too many automation actions — slow down." }, { status: 429, headers: { "cache-control": "no-store" } });
  }
  let body: { action?: unknown; name?: unknown; optIn?: unknown; id?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "opt-in") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!NAME_RE.test(name) || typeof body.optIn !== "boolean") {
      return NextResponse.json({ error: "Valid container name and optIn boolean required." }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    await setTargetOptIn(name, body.optIn);
    await recordAudit({
      actor, sourceIp: guard.sourceIp, kind: "update", action: "automation-opt-in",
      targetName: name, targetId: String(body.optIn), result: "success", durationMs: 0,
    }).catch(() => {});
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  }

  if (action === "ack") {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!NAME_RE.test(name)) {
      return NextResponse.json({ error: "Valid container name required." }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    await acknowledgeTarget(name);
    await recordAudit({
      actor, sourceIp: guard.sourceIp, kind: "update", action: "automation-ack",
      targetName: name, targetId: name, result: "success", durationMs: 0,
    }).catch(() => {});
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  }

  if (action === "cancel") {
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!/^[a-z0-9-]{4,40}$/.test(id)) {
      return NextResponse.json({ error: "Valid job id required." }, { status: 400, headers: { "cache-control": "no-store" } });
    }
    const cancelled = await cancelQueuedJob(id);
    await recordAudit({
      actor, sourceIp: guard.sourceIp, kind: "update", action: "automation-cancel",
      targetName: id, targetId: id, result: cancelled ? "success" : "not-found", durationMs: 0,
    }).catch(() => {});
    return NextResponse.json({ ok: cancelled }, { status: cancelled ? 200 : 404, headers: { "cache-control": "no-store" } });
  }

  if (action === "run-once") {
    const result = await runOnce();
    await recordAudit({
      actor, sourceIp: guard.sourceIp, kind: "update", action: "automation-run-once",
      targetName: result.started ?? "none", targetId: result.summary.slice(0, 120), result: "success", durationMs: 0,
    }).catch(() => {});
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  }

  return NextResponse.json(
    { error: "Unknown action. Allowed: opt-in, ack, cancel, run-once." },
    { status: 400, headers: { "cache-control": "no-store" } },
  );
}
