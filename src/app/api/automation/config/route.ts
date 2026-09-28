import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { recordAudit } from "@/server/actions/audit";
import { setConfig } from "@/server/automation/status";

export const dynamic = "force-dynamic";

/**
 * Automation config (v0.8.0): structured fields only — no cron expressions
 * from the browser. The server normalizes + validates (window shape,
 * bounds, timezone); the frontend can never mark an ineligible target
 * eligible or alter risk/digest/source.
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "trusted-local";
  const rate = checkWriteRate(`automation-config:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json({ error: "Too many automation config changes — slow down." }, { status: 429, headers: { "cache-control": "no-store" } });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const result = await setConfig(body);
  await recordAudit({
    actor,
    sourceIp: guard.sourceIp,
    kind: "update",
    action: "automation-config",
    targetName: JSON.stringify(body).slice(0, 100),
    targetId: "automation-config",
    result: result.ok ? "success" : "rejected",
    durationMs: 0,
    ...(result.error ? { error: result.error } : {}),
  }).catch(() => {});
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
