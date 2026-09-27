import { NextResponse, type NextRequest } from "next/server";
import { guardRead, guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { createBackup, listBackups, validateBackup } from "@/server/resilience/backup";
import { recordAudit } from "@/server/actions/audit";

export const dynamic = "force-dynamic";

/** Lijst resilience-backups (read-only). */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const backups = await listBackups();
  return NextResponse.json({ backups }, { headers: { "cache-control": "no-store" } });
}

/** Maakt een resilience-backup (guard write + rate limit + audit). */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "trusted-local";
  const rate = checkWriteRate(`resilience-backup:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many backup requests — slow down." },
      { status: 429, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const result = await createBackup();
    await recordAudit({
      actor, sourceIp: guard.sourceIp, kind: "dashboard", action: "resilience-backup",
      targetName: result.file, targetId: `${result.bytes} bytes`,
      result: "success", durationMs: 0,
    }).catch(() => {});
    return NextResponse.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Backup failed." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
