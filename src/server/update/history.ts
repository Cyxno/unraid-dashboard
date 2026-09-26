import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { getEnvSafe } from "@/server/env";
import type { UpdateHelperStatus } from "@/server/update/helper-client";

/**
 * Persisted update history (v0.7.1): one JSON object per line under
 * /app/data/update-history.jsonl — the durable record of every update
 * machine result the helper reports. Never contains secrets.
 *
 * Records are appended when the helper's lastUpdate carries a
 * (startedAt,to) pair not yet persisted — this survives the dashboard
 * container being REPLACED mid-update: the new instance reconciles from
 * the helper on its first status poll.
 */

export interface UpdateHistoryEntry {
  /** Machine completion time (ISO). */
  timestamp: string;
  /** Machine start time — the dedupe key against helper state. */
  startedAt: string;
  actor: string;
  fromVersion: string;
  fromDigest: string | null;
  toVersion: string;
  toDigest: string | null;
  durationMs: number;
  /** Phases the machine actually reached (best effort from its log). */
  phasesReached: string[];
  result: "success" | "rolled-back" | "failed";
  rollbackPerformed: boolean;
  usedLocalImage: boolean;
  error?: string;
}

const MAX_BYTES = 512 * 1024;
const KEEP_ROTATED = 2;

const globalStore = globalThis as unknown as {
  __dashboardUpdateHistoryQueue?: Promise<void>;
  /** Pending request-side actor handoff: {tag, actor, requestedAt}. */
  __dashboardUpdatePending?: { tag: string; actor: string; requestedAt: number } | null;
};

/** Remembers who requested the pending update so the reconciled history
 * entry can carry the real actor. */
export function setPendingUpdateRequest(tag: string, actor: string): void {
  globalStore.__dashboardUpdatePending = { tag, actor, requestedAt: Date.now() };
}

function historyPath(): string {
  return `${getEnvSafe().AUDIT_DIR}/update-history.jsonl`;
}

/** Reads the history, newest first. Corrupt lines are skipped. */
export async function readUpdateHistory(): Promise<UpdateHistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(historyPath(), "utf8");
  } catch {
    return [];
  }
  const entries: UpdateHistoryEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as UpdateHistoryEntry;
      if (typeof parsed.timestamp === "string" && typeof parsed.toVersion === "string") {
        entries.push(parsed);
      }
    } catch {
      // skip corrupt line
    }
  }
  entries.reverse();
  return entries;
}

/**
 * Reconciles the helper's lastUpdate into the persisted history. The
 * helper reports the ACTOR it was given at request time? It does not —
 * the dashboard-side request route audits the actor; the machine result
 * is reconciled here with actor "helper-machine" unless the audit trail
 * provides better context. Honest and simple.
 */
export async function maybeRecordFromHelper(
  helper: UpdateHelperStatus,
): Promise<{ recorded: boolean }> {
  const last = helper.lastUpdate;
  if (!last || !last.finishedAt || !last.to || !last.startedAt) return { recorded: false };

  const existing = await readUpdateHistory();
  if (existing.some((entry) => entry.startedAt === last.startedAt && entry.toVersion === versionFromRef(last.to))) {
    return { recorded: false };
  }

  const fromVersion = versionFromRef(last.from);
  const toVersion = versionFromRef(last.to);

  // Resolve the actor: a pending dashboard-side request that matches the
  // machine's start time; otherwise look it up in the audit trail (the
  // in-memory handoff dies with the replaced container, but the request
  // was audited there first); otherwise the machine ran host-side.
  const pending = globalStore.__dashboardUpdatePending ?? null;
  let actor =
    pending && pending.tag === toVersion && last.startedAt && new Date(last.startedAt).getTime() >= pending.requestedAt - 1000
      ? pending.actor
      : "";
  if (!actor) {
    try {
      const { readAudit } = await import("@/server/actions/audit");
      const auditTrail = await readAudit(100);
      const match = auditTrail.entries.find(
        (entry) =>
          entry.kind === "update" &&
          entry.action === "request" &&
          entry.targetId === toVersion &&
          entry.result === "success" &&
          new Date(entry.timestamp).getTime() <= new Date(last.startedAt).getTime() + 60_000 &&
          Date.now() - new Date(entry.timestamp).getTime() < 3_600_000,
      );
      actor = match?.actor ?? "helper-machine";
    } catch {
      actor = "helper-machine";
    }
  }

  const entry: UpdateHistoryEntry = {
    timestamp: last.finishedAt,
    startedAt: last.startedAt,
    actor,
    fromVersion,
    fromDigest: null,
    toVersion,
    toDigest: last.digest ?? null,
    durationMs: last.durationMs ?? 0,
    phasesReached: phasesFromLog(helper.log),
    result: (last.result as UpdateHistoryEntry["result"]) ?? "failed",
    rollbackPerformed: last.result === "rolled-back",
    usedLocalImage: Boolean(last.usedLocalImage),
    ...(last.error ? { error: String(last.error).slice(0, 300) } : {}),
  };

  const previous = globalStore.__dashboardUpdateHistoryQueue ?? Promise.resolve();
  globalStore.__dashboardUpdateHistoryQueue = previous
    .then(() => appendRotated(entry))
    .catch((error) => {
      console.error("[update-history] write failed:", error instanceof Error ? error.message : error);
    });
  await globalStore.__dashboardUpdateHistoryQueue;
  if (actor !== "helper-machine") globalStore.__dashboardUpdatePending = null;
  return { recorded: true };
}

/** Records an entry with a known actor (request-side hook). */
export async function recordUpdateEntry(entry: UpdateHistoryEntry): Promise<void> {
  const previous = globalStore.__dashboardUpdateHistoryQueue ?? Promise.resolve();
  globalStore.__dashboardUpdateHistoryQueue = previous
    .then(() => appendRotated(entry))
    .catch((error) => {
      console.error("[update-history] write failed:", error instanceof Error ? error.message : error);
    });
  await globalStore.__dashboardUpdateHistoryQueue;
}

function versionFromRef(ref: string): string {
  // "ghcr.io/cyxno/unraid-dashboard:0.7.1" → "0.7.1"; bare tags pass through.
  const tag = ref.includes(":") ? ref.split(":").pop() ?? ref : ref;
  return tag.replace(/^v/, "").slice(0, 32);
}

function phasesFromLog(log: Array<{ phase: string }>): string[] {
  const seen: string[] = [];
  for (const entry of log) {
    if (!seen.includes(entry.phase)) seen.push(entry.phase);
  }
  return seen;
}

async function appendRotated(entry: UpdateHistoryEntry): Promise<void> {
  const path = historyPath();
  await mkdir(getEnvSafe().AUDIT_DIR, { recursive: true }).catch(() => {});
  const line = `${JSON.stringify(entry)}\n`;
  let content: string | null = null;
  try {
    content = await readFile(path, "utf8");
  } catch {
    content = null;
  }
  if (content !== null && Buffer.byteLength(content, "utf8") + line.length > MAX_BYTES) {
    // Rotate: live → .1 (drop older rotation).
    await rename(`${path}.1`, `${path}.2`).catch(() => {});
    await rename(path, `${path}.1`).catch(() => {});
    await writeFile(path, "", { mode: 0o600 }).catch(() => {});
  }
  await appendFile(path, line, { encoding: "utf8" }).catch(async (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      await writeFile(path, line, { mode: 0o600 });
    } else {
      throw error;
    }
  });
}

/** Test hook. */
export function resetUpdateHistoryQueue(): void {
  globalStore.__dashboardUpdateHistoryQueue = undefined;
}
