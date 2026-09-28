import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { recordAudit } from "@/server/actions/audit";
import { listBackups, validateBackup, createBackup } from "@/server/resilience/backup";
import { requestClearStale, getHelperSnapshots } from "@/server/update/helper-client";
import { resetUpdateDetection } from "@/server/docker/updates";
import { resetUpdateCheck, checkForUpdate } from "@/server/actions/update-check";
import { readFile } from "node:fs/promises";
import { getEnvSafe } from "@/server/env";

export const dynamic = "force-dynamic";

const ACTIONS = new Set(["backup-create", "backup-validate", "backup-dry-run", "retry-dependency-check", "clear-stale-operation"]);

/**
 * Safe recovery actions (v0.7.13). Deliberately NO generic shell, no
 * arbitrary restore, no arbitrary image rollback:
 *  - backup-create:      resilience backup (same as POST /api/resilience)
 *  - backup-validate:    checksum/schema validation of the latest backup
 *  - backup-dry-run:     what a restore WOULD do, written nowhere
 *  - retry-dependency-check: clears registry-check caches and re-probes
 *  - clear-stale-operation: helper-side stale PRE-mutation op clear
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "trusted-local";
  const rate = checkWriteRate(`operations-action:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json({ error: "Too many recovery actions — slow down." }, { status: 429, headers: { "cache-control": "no-store" } });
  }

  let body: { action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (!ACTIONS.has(action)) {
    return NextResponse.json({ error: `Unknown action. Allowed: ${[...ACTIONS].join(", ")}.` }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  const startedAt = Date.now();
  try {
    if (action === "backup-create") {
      const result = await createBackup();
      await audit(action, actor, guard.sourceIp, "success", Date.now() - startedAt, result.file);
      return NextResponse.json({ ok: true, action, result }, { headers: { "cache-control": "no-store" } });
    }

    if (action === "backup-validate" || action === "backup-dry-run") {
      const backups = await listBackups();
      const latest = backups[0];
      if (!latest) {
        await audit(action, actor, guard.sourceIp, "rejected", Date.now() - startedAt, "no backup present");
        return NextResponse.json({ ok: false, error: "No resilience backup exists yet — create one first." }, { status: 404, headers: { "cache-control": "no-store" } });
      }
      const validation = await validateBackup(latest.file);
      let dryRun: Record<string, unknown> | null = null;
      if (action === "backup-dry-run" && validation.ok) {
        // Describe what a restore WOULD write — nothing is written.
        const raw = await readFile(`${getEnvSafe().AUDIT_DIR}/backups/resilience/${latest.file}`, "utf8");
        const archive = JSON.parse(raw) as {
          dashboards?: Record<string, unknown>;
          updateHistory?: string;
          auditMetadata?: string;
        };
        dryRun = {
          wouldRestoreDashboards: Object.keys(archive.dashboards ?? {}).length,
          dashboardFiles: Object.keys(archive.dashboards ?? {}).slice(0, 50),
          updateHistoryLines: (archive.updateHistory ?? "").split("\n").filter((line) => line.trim().length > 0).length,
          auditMetadataPresent: Boolean(archive.auditMetadata),
          note: "Dry-run only — nothing was written.",
        };
      }
      const payload = { ok: validation.ok, action, backup: latest, ...(validation.reason ? { reason: validation.reason } : {}), ...(validation.entries !== undefined ? { entries: validation.entries } : {}), ...(dryRun ? { dryRun } : {}) };
      await audit(action, actor, guard.sourceIp, validation.ok ? "success" : "failed", Date.now() - startedAt, latest.file);
      return NextResponse.json(payload, { status: validation.ok ? 200 : 422, headers: { "cache-control": "no-store" } });
    }

    if (action === "retry-dependency-check") {
      resetUpdateDetection();
      resetUpdateCheck();
      const release = await checkForUpdate().catch(() => null);
      const snapshots = await getHelperSnapshots().catch(() => null);
      const payload = {
        ok: true,
        action,
        result: {
          release: release ? { status: release.status, latestTag: release.latestTag, registryAuthorized: release.registry.authorized } : null,
          snapshotsReachable: snapshots !== null,
          note: "Registry check caches cleared; next overview poll re-HEADs every image (bounded, serialized).",
        },
      };
      await audit(action, actor, guard.sourceIp, "success", Date.now() - startedAt, null);
      return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
    }

    // clear-stale-operation
    const result = await requestClearStale();
    if (result.status !== 200) {
      await audit(action, actor, guard.sourceIp, "failed", Date.now() - startedAt, result.reason ?? `HTTP ${result.status}`);
      return NextResponse.json({ ok: false, error: result.reason ?? "Helper refused the clear." }, { status: result.status, headers: { "cache-control": "no-store" } });
    }
    await audit(action, actor, guard.sourceIp, "success", Date.now() - startedAt, (result.cleared ?? []).join(",") || "nothing stale");
    return NextResponse.json({ ok: true, action, result: { cleared: result.cleared ?? [], refused: result.refused ?? [] } }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "action failed";
    await audit(action, actor, guard.sourceIp, "failed", Date.now() - startedAt, message).catch(() => {});
    return NextResponse.json({ ok: false, error: message }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}

async function audit(action: string, actor: string, sourceIp: string, result: "success" | "rejected" | "failed", durationMs: number, target: string | null): Promise<void> {
  await recordAudit({
    actor,
    sourceIp,
    kind: "recovery",
    action,
    targetName: target ?? action,
    targetId: action,
    result,
    durationMs,
  }).catch(() => {});
}
