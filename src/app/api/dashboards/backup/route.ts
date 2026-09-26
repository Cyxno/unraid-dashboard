import { NextResponse, type NextRequest } from "next/server";
import { guardRead, guardWrite } from "@/server/auth/guard";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getEnvSafe } from "@/server/env";
import { listDashboards } from "@/server/dashboards/store";
import { recordAudit } from "@/server/actions/audit";
import { checkWriteRate } from "@/server/dashboards/rate-limit";

export const dynamic = "force-dynamic";

const BACKUP_DIR = "backups";
const MAX_BACKUPS = 10;

function backupsDir(): string {
  // Lives next to the dashboards store on the narrow app-data volume.
  return path.join(getEnvSafe().DASHBOARDS_DIR, BACKUP_DIR);
}

/**
 * Server-side backup of all shared dashboards (sanitized schema shape
 * only — the schema cannot hold secrets) into /app/data/backups with
 * rotation (MAX_BACKUPS newest kept).
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  const actor = guard.identity.user ?? "lan";
  const rate = checkWriteRate(`backup:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many backup requests." },
      { status: 429, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    const { dashboards } = await listDashboards();
    const payload = {
      exporter: "unraid-dashboard",
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      dashboards: dashboards.map((dashboard) => ({
        name: dashboard.name,
        widgets: dashboard.widgets,
        preferences: dashboard.preferences,
      })),
    };
    const dir = backupsDir();
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = `dashboards-${stamp}.json`;
    await writeFile(path.join(dir, file), JSON.stringify(payload, null, 2), { mode: 0o600 });

    // Rotation: keep the newest MAX_BACKUPS files.
    const names = (await readdir(dir)).filter((name) => name.startsWith("dashboards-") && name.endsWith(".json")).sort();
    const excess = names.slice(0, Math.max(0, names.length - MAX_BACKUPS));
    for (const name of excess) {
      await rm(path.join(dir, name), { force: true }).catch(() => {});
    }

    await recordAudit({
      actor,
      sourceIp: guard.sourceIp,
      kind: "dashboard",
      action: "backup",
      targetName: file,
      targetId: `${dashboards.length} dashboard(s)`,
      result: "success",
      durationMs: 0,
    }).catch(() => {});

    return NextResponse.json(
      { backup: file, dashboards: dashboards.length, rotated: excess.length },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Backup failed (storage not writable?)." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

/** Lists existing server-side backups (names + sizes + timestamps only). */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  try {
    const dir = backupsDir();
    const names = (await readdir(dir)).filter((name) => name.startsWith("dashboards-") && name.endsWith(".json")).sort().reverse();
    const backups = [];
    for (const name of names.slice(0, MAX_BACKUPS)) {
      const info = await stat(path.join(dir, name)).catch(() => null);
      if (info) backups.push({ file: name, bytes: info.size, createdAt: info.mtime.toISOString() });
    }
    return NextResponse.json({ backups }, { headers: { "cache-control": "no-store" } });
  } catch {
    return NextResponse.json({ backups: [] }, { headers: { "cache-control": "no-store" } });
  }
}
