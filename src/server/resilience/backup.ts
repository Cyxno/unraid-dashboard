import { z } from "zod";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { getEnvSafe } from "@/server/env";
import { listDashboards } from "@/server/dashboards/store";
import { readUpdateHistory } from "@/server/update/history";

/**
 * Backup/restore voor de persistente dashboard-state (v0.7.12).
 *
 * Bevat uitsluitend niet-geheime data:
 * - shared dashboards (schema-gevalideerd)
 * - update-historie (van → naar, resultaat — geen tokens)
 *
 * Bevat NOOIT:
 * - API keys, PATs, proxy secrets, Docker credentials, env waarden
 *
 * Backups worden geschreven naar /app/data/backups/resilience/ met
 * timestamp, manifest en SHA-256 checksums. Retentie: laatste 7.
 */

const BACKUP_DIR = "resilience";
const MAX_BACKUPS = 7;

const backupManifestSchema = z.object({
  createdAt: z.string().datetime(),
  schemaVersion: z.number(),
  contents: z.array(z.object({ file: z.string(), sha256: z.string(), bytes: z.number() })),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;

function backupDir(): string {
  return path.join(getEnvSafe().AUDIT_DIR, "backups", BACKUP_DIR);
}

function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Maakt een timestamped backup van alle persistente niet-geheime state. */
export async function createBackup(): Promise<{ file: string; bytes: number; sha256: string }> {
  const dir = backupDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const contents: BackupManifest["contents"] = [];

  // 1. Shared dashboards
  const dashDir = path.join(getEnvSafe().DASHBOARDS_DIR);
  const dashboards: Record<string, unknown> = {};
  try {
    const files = await readdir(dashDir);
    for (const file of files.filter((f) => f.endsWith(".json"))) {
      const raw = await readFile(path.join(dashDir, file), "utf8");
      dashboards[file] = JSON.parse(raw);
    }
  } catch { /* dashboards dir missing — ok */ }
  const dashStr = JSON.stringify(dashboards, null, 2);
  contents.push({ file: "dashboards.json", sha256: sha256(dashStr), bytes: Buffer.byteLength(dashStr) });

  // 2. Update history
  let updateHistory = "";
  try {
    updateHistory = await readFile(path.join(getEnvSafe().AUDIT_DIR, "update-history.jsonl"), "utf8");
  } catch { updateHistory = ""; }
  contents.push({ file: "update-history.jsonl", sha256: sha256(updateHistory), bytes: Buffer.byteLength(updateHistory) });

  // 3. Audit metadata (aantal entries, geen inhoud — audit zelf kan gevoelig zijn)
  let auditMeta = "";
  try {
    const auditRaw = await readFile(path.join(getEnvSafe().AUDIT_DIR, "audit.jsonl"), "utf8");
    const lines = auditRaw.trim().split("\n").filter(Boolean);
    const lastLine = lines[lines.length - 1];
    const lastTs = lastLine ? String(JSON.parse(lastLine).timestamp ?? "") : null;
    auditMeta = JSON.stringify({ entryCount: lines.length, lastTimestamp: lastTs });
  } catch { auditMeta = JSON.stringify({ entryCount: 0 }); }
  contents.push({ file: "audit-metadata.json", sha256: sha256(auditMeta), bytes: Buffer.byteLength(auditMeta) });

  // Manifest + archiefbestand
  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    schemaVersion: 1,
    contents,
  };
  const archive = {
    manifest,
    dashboards: dashStr ? JSON.parse(dashStr) : {},
    updateHistory,
    auditMetadata: auditMeta,
  };
  const archiveStr = JSON.stringify(archive, null, 2);
  const file = `resilience-${stamp}.json`;
  const filePath = path.join(dir, file);
  await writeFile(filePath, archiveStr, { mode: 0o600 });
  const bytes = Buffer.byteLength(archiveStr);

  // Retentie: houd de laatste MAX_BACKUPS
  const names = (await readdir(dir)).filter((n) => n.startsWith("resilience-") && n.endsWith(".json")).sort();
  for (const old of names.slice(0, Math.max(0, names.length - MAX_BACKUPS))) {
    await rm(path.join(dir, old), { force: true }).catch(() => {});
  }

  return { file, bytes: Buffer.byteLength(archiveStr), sha256: sha256(archiveStr) };
}

/** Lijst beschikbare resilience-backups. */
export async function listBackups(): Promise<Array<{ file: string; bytes: number; createdAt: string }>> {
  const dir = backupDir();
  try {
    const names = (await readdir(dir)).filter((n) => n.startsWith("resilience-") && n.endsWith(".json")).sort().reverse();
    const out = [];
    for (const name of names.slice(0, MAX_BACKUPS)) {
      const info = await stat(path.join(dir, name)).catch(() => null);
      if (info) out.push({ file: name, bytes: info.size, createdAt: info.mtime.toISOString() });
    }
    return out;
  } catch {
    return [];
  }
}

/** Validatie van een backup-archief zonder te herstellen (dry-run). */
export async function validateBackup(file: string): Promise<{ ok: boolean; reason?: string; entries?: number }> {
  if (!/^resilience-[0-9TZ-]+\.json$/.test(file)) return { ok: false, reason: "invalid filename" };
  try {
    const raw = await readFile(path.join(backupDir(), file), "utf8");
    const parsed = JSON.parse(raw) as { manifest?: BackupManifest; dashboards?: Record<string, unknown> };
    if (!parsed.manifest || parsed.manifest.schemaVersion !== 1) return { ok: false, reason: "unsupported schema version" };
    if (!parsed.dashboards || typeof parsed.dashboards !== "object") return { ok: false, reason: "missing dashboards" };
    // Checksum-verificatie
    for (const entry of parsed.manifest.contents ?? []) {
      if (entry.file === "dashboards.json") {
        const computed = sha256(JSON.stringify(parsed.dashboards, null, 2));
        if (computed !== entry.sha256) return { ok: false, reason: "dashboard checksum mismatch" };
      }
    }
    return { ok: true, entries: Object.keys(parsed.dashboards).length };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "read error" };
  }
}

/** Herstelt dashboards uit een resilience-backup. Overschrijft alleen dashboards. */
export async function restoreFromBackup(file: string): Promise<{ restored: number }> {
  const validation = await validateBackup(file);
  if (!validation.ok) throw new Error(`backup validation failed: ${validation.reason}`);
  const raw = await readFile(path.join(backupDir(), file), "utf8");
  const archive = JSON.parse(raw) as {
    dashboards: Record<string, { name: string; [key: string]: unknown }>;
  };
  const dashDir = getEnvSafe().DASHBOARDS_DIR;
  let restored = 0;
  for (const [fileName, dashboard] of Object.entries(archive.dashboards ?? {})) {
    if (typeof dashboard === "object" && dashboard !== null && "name" in dashboard) {
      await writeFile(path.join(dashDir, fileName), JSON.stringify(dashboard, null, 2), { mode: 0o600 });
      restored++;
    }
  }
  return { restored };
}



