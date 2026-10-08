import { constants as fsConstants } from "node:fs/promises";
import { access, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { getEnvSafe } from "@/server/env";
import { incidentsStateFilePath, lastIncidentsSaveError, lastSuccessfulPersistAt } from "./store";
import { noteSourceAttempt } from "./source-health";

/**
 * Persistence self-check (v1.5.0 Fase 25).
 *
 * After the historical `/app/data`-not-actually-persistent bug, Beacon
 * verifies its own durability explicitly and NON-destructively:
 *   - the data directory exists and accepts a probe write (temp file,
 *     immediately removed — never touches state files),
 *   - the expected mount path is the configured AUDIT_DIR,
 *   - the last successful persistence timestamp is surfaced.
 *
 * A likely-ephemeral volume must be VISIBLE, not silently green.
 */

export interface PersistenceHealth {
  dataDir: string;
  dataDirExists: boolean;
  dataDirWritable: boolean | null;
  probeError: string | null;
  incidentsStateFile: string;
  lastSaveError: string | null;
  lastPersistAt: string | null;
  /** True when writes fail — durability almost certainly broken. */
  failing: boolean;
  checkedAt: string;
}

const globalCache = globalThis as unknown as {
  __persistenceCheck?: { at: number; value: PersistenceHealth };
};

const PROBE_CACHE_MS = 60_000;
const PROBE_FILE = ".beacon-persistence-probe";

/** Unique per probe: concurrent callers (observe cycle + diagnostics
 *  request) raced on one shared probe file — one unlink hit ENOENT and
 *  briefly read as "degraded" (production 2h-observation finding). */
function probePath(dataDir: string): string {
  return join(dataDir, `${PROBE_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`);
}

async function probeOnce(): Promise<PersistenceHealth> {
  const env = getEnvSafe();
  const dataDir = env.AUDIT_DIR;
  const checkedAt = new Date().toISOString();
  let dataDirExists = false;
  let dataDirWritable: boolean | null = null;
  let probeError: string | null = null;

  try {
    await access(dataDir, fsConstants.F_OK);
    dataDirExists = true;
  } catch {
    dataDirExists = false;
  }

  if (dataDirExists) {
    const probe = probePath(dataDir);
    try {
      await writeFile(probe, String(Date.now()), { mode: 0o600 });
      await unlink(probe);
      dataDirWritable = true;
    } catch (error) {
      dataDirWritable = false;
      probeError = error instanceof Error ? error.message : String(error);
      // A lost race on the probe file (ENOENT at unlink) proves nothing
      // about writability — the WRITE succeeded, which is the question.
      if (probeError.includes("ENOENT") && probeError.includes("unlink")) {
        dataDirWritable = true;
        probeError = null;
      }
    }
  } else {
    dataDirWritable = false;
    probeError = `data directory does not exist: ${dataDir}`;
  }

  const saveError = lastIncidentsSaveError();
  const failing = dataDirWritable === false || saveError != null;

  if (dataDirWritable === false) {
    noteSourceAttempt("persistence", { ok: false, at: Date.now(), safeError: probeError ?? "data dir not writable" });
  }

  return {
    dataDir,
    dataDirExists,
    dataDirWritable,
    probeError,
    incidentsStateFile: incidentsStateFilePath(),
    lastSaveError: saveError?.message ?? null,
    lastPersistAt: lastSuccessfulPersistAt(),
    failing,
    checkedAt,
  };
}

/** Cached (60s) persistence self-check — safe to call per request. */
export async function getPersistenceHealth(): Promise<PersistenceHealth> {
  const cached = globalCache.__persistenceCheck;
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS && !cached.value.failing) {
    return cached.value;
  }
  const value = await probeOnce();
  globalCache.__persistenceCheck = { at: Date.now(), value };
  return value;
}

/** Test hook. */
export function resetPersistenceCheckCache(): void {
  globalCache.__persistenceCheck = undefined;
}
