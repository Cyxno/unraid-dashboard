import { appendFile, mkdir, readFile, rename, readdir, unlink, writeFile } from "node:fs/promises";
import { getEnv } from "@/server/env";
import type { AuditEntry } from "@/lib/api-types";

/**
 * Append-only JSONL audit trail for write actions.
 *
 * - One JSON object per line under AUDIT_DIR (default /app/data).
 * - Rotated by size (AUDIT_ROTATE_BYTES) with AUDIT_KEEP rotated files kept.
 * - Never contains API keys, tokens, authorization headers, or env values —
 *   only the fields of AuditEntry.
 */

const MAX_BYTES = 2 * 1024 * 1024; // rotate at 2 MiB
const KEEP_ROTATED = 4; // + the live file

const globalStore = globalThis as unknown as {
  __dashboardAuditQueue?: Promise<void>;
};

function newId(now: number): string {
  return `a${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeError(error: unknown): string | undefined {
  if (error === null || error === undefined) return undefined;
  const message = error instanceof Error ? error.message : String(error);
  // Defensive: strip anything that smells like a credential assignment.
  const cleaned = message
    .replace(/\b(X-Api-Key|x-api-key|api[_-]?key|token|password|authorization)\b\s*[:=]\s*\S+/gi, "$1=<redacted>")
    .slice(0, 300);
  return cleaned.length > 0 ? cleaned : undefined;
}

export interface AuditInput {
  actor: string;
  sourceIp: string;
  kind: "docker" | "vm" | "notification" | "dashboard" | "update" | "recovery" | "remediation";
  action: string;
  targetName: string;
  targetId: string;
  result: AuditEntry["result"];
  durationMs: number;
  error?: unknown;
  /** v1.7.0 remediation traceability (safe metadata only). */
  incidentId?: string;
  operationId?: string;
  traceId?: string;
}

/** Writes one audit entry; never throws into the request path. */
export async function recordAudit(input: AuditInput): Promise<string> {
  const now = Date.now();
  const entry: AuditEntry = {
    id: newId(now),
    timestamp: new Date(now).toISOString(),
    actor: input.actor || "local",
    sourceIp: input.sourceIp || "unknown",
    kind: input.kind,
    action: input.action,
    targetName: input.targetName.slice(0, 120),
    targetId: input.targetId.slice(0, 200),
    result: input.result,
    durationMs: input.durationMs,
    ...(sanitizeError(input.error) ? { error: sanitizeError(input.error) } : {}),
    ...(input.incidentId ? { incidentId: input.incidentId.slice(0, 200) } : {}),
    ...(input.operationId ? { operationId: input.operationId.slice(0, 40) } : {}),
    ...(input.traceId ? { traceId: input.traceId.slice(0, 60) } : {}),
  };

  // Serialize writes through a shared promise to keep the queue honest.
  const previous = globalStore.__dashboardAuditQueue ?? Promise.resolve();
  globalStore.__dashboardAuditQueue = previous
    .then(() => writeEntry(entry))
    .catch((error) => {
      console.error("[audit] write failed:", error instanceof Error ? error.message : error);
    });
  await globalStore.__dashboardAuditQueue;
  return entry.id;
}

async function writeEntry(entry: AuditEntry): Promise<void> {
  const dir = getEnv().AUDIT_DIR;
  await mkdir(dir, { recursive: true });
  const live = `${dir}/audit.jsonl`;
  const line = `${JSON.stringify(entry)}\n`;

  // Rotate when the live file grows past the cap.
  try {
    const content = await readFile(live, "utf8").catch(() => null);
    if (content !== null && Buffer.byteLength(content, "utf8") + line.length > MAX_BYTES) {
      await rotate(dir, content);
    }
  } catch {
    // Rotation is best-effort; the append below still proceeds.
  }

  await appendFile(live, line, { encoding: "utf8" });
}

async function rotate(dir: string, liveContent: string): Promise<void> {
  // audit.jsonl -> audit.1.jsonl; audit.N -> audit.N+1 (drop the oldest).
  const rotated: string[] = [];
  try {
    const files = await readdir(dir);
    for (const file of files) {
      const match = file.match(/^audit\.(\d+)\.jsonl$/);
      if (match) rotated.push(file);
    }
  } catch {
    return;
  }
  for (const file of rotated.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))) {
    const index = Number(file.match(/\d+/)![0]);
    const next = `${dir}/audit.${index + 1}.jsonl`;
    if (index + 1 > KEEP_ROTATED) {
      await unlink(`${dir}/${file}`).catch(() => {});
    } else {
      await rename(`${dir}/${file}`, next).catch(() => {});
    }
  }
  await writeFile(`${dir}/audit.1.jsonl`, liveContent);
}

/** Reads the audit log, newest first. */
export async function readAudit(limit = 200): Promise<{
  entries: AuditEntry[];
  total: number;
  truncated: boolean;
}> {
  const dir = getEnv().AUDIT_DIR;
  const entries: AuditEntry[] = [];
  let truncated = false;

  const load = async (file: string): Promise<AuditEntry[]> => {
    try {
      const content = await readFile(`${dir}/${file}`, "utf8");
      const parsed: AuditEntry[] = content
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          try {
            return JSON.parse(line) as AuditEntry;
          } catch {
            return null;
          }
        })
        .filter((entry): entry is AuditEntry => entry !== null);
      return parsed;
    } catch {
      return [];
    }
  };

  // Newest entries live in the current file, then audit.1, audit.2 …
  entries.push(...(await load("audit.jsonl")).reverse());
  if (entries.length < limit) {
    for (let index = 1; index <= KEEP_ROTATED && entries.length < limit; index++) {
      const older = (await load(`audit.${index}.jsonl`)).reverse();
      entries.push(...older);
    }
  }
  if (entries.length > limit) {
    entries.length = limit;
    truncated = true;
  }
  return { entries, total: entries.length, truncated };
}

/** Test hook. */
export function resetAuditQueue(): void {
  globalStore.__dashboardAuditQueue = undefined;
}
