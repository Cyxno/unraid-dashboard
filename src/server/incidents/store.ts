import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getEnvSafe } from "@/server/env";
import type { Incident } from "@/lib/api-types";
import {
  INCIDENT_RECOVERED_HISTORY_MAX,
  INCIDENT_RECOVERY_RETENTION_MS,
} from "@/server/thresholds";
import { noteSourceAttempt } from "./source-health";

/**
 * Incident persistence (v1.5.0 Fase 12).
 *
 * One JSON file under /app/data, same durability model as the
 * notification state: atomic temp+rename writes, debounced saves, boot-
 * safe hydration. Keeps ACTIVE incidents and a BOUNDED recovered history
 * so incidents and their durations survive container recreates without
 * unbounded state-file growth.
 */

export interface IncidentsState {
  version: 1;
  /** Active + recently recovered incidents by fingerprint. */
  incidents: Record<string, Incident>;
  /** When the engine last evaluated (observability). */
  lastEvaluatedAt: string | null;
  /**
   * First-cycle marker: on the very first cycle after boot/upgrade the
   * current conditions are ingested SILENTLY (notifiedAt preset) so an
   * upgrade never floods devices with pre-existing incidents (Fase 33).
   */
  baselinedAt: number | null;
  /** Debounce anchors: fingerprint → condition first-seen (ms). */
  pending: Record<string, number>;
  /** container name → restart-event timestamps (crash-loop evidence). */
  restarts: Record<string, number[]>;
  /** container name → last observed docker restartCount. */
  restartCounts: Record<string, { count: number; at: number }>;
  /** fingerprint → condition toggle timestamps (flap detection). */
  toggles: Record<string, number[]>;
  /** fingerprint → last cycle the condition was positively observed. */
  matchedAt: Record<string, number>;
  /** fingerprint → since when the condition is present again (flap end). */
  presentSince: Record<string, number>;
}

const globalStore = globalThis as unknown as {
  __incidentsState?: IncidentsState | null;
  __incidentsSaveError?: { message: string; at: string } | null;
};

export function incidentsStateFilePath(): string {
  return join(getEnvSafe().AUDIT_DIR, "incidents-state.json");
}

function emptyState(): IncidentsState {
  return {
    version: 1,
    incidents: {},
    lastEvaluatedAt: null,
    baselinedAt: null,
    pending: {},
    restarts: {},
    restartCounts: {},
    toggles: {},
    matchedAt: {},
    presentSince: {},
  };
}

export function loadIncidentsState(): IncidentsState {
  if (globalStore.__incidentsState) return globalStore.__incidentsState;
  globalStore.__incidentsState = emptyState();
  return globalStore.__incidentsState;
}

let hydrationPromise: Promise<IncidentsState> | null = null;

/** Boot-safe hydration — must run before the first mutation (see
 *  notifications/store.ts for the failure mode this prevents). */
export function ensureIncidentsState(): Promise<IncidentsState> {
  if (globalStore.__incidentsState) return Promise.resolve(globalStore.__incidentsState);
  hydrationPromise ??= loadIncidentsStateFromDisk();
  return hydrationPromise;
}

function isValidIncident(value: unknown): value is Incident {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Incident;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.entity === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.severity === "string" &&
    (candidate.status === "active" || candidate.status === "recovered") &&
    typeof candidate.firstSeenAt === "string"
  );
}

export async function loadIncidentsStateFromDisk(): Promise<IncidentsState> {
  if (globalStore.__incidentsState) return globalStore.__incidentsState;
  const fallback = emptyState();
  try {
    const raw = JSON.parse(await readFile(incidentsStateFilePath(), "utf8")) as Partial<IncidentsState>;
    const incidents: Record<string, Incident> = {};
    if (raw.incidents && typeof raw.incidents === "object") {
      for (const [id, incident] of Object.entries(raw.incidents)) {
        if (isValidIncident(incident)) incidents[id] = incident;
      }
    }
    globalStore.__incidentsState = {
      version: 1,
      incidents: pruneIncidents(incidents, Date.now()),
      lastEvaluatedAt: typeof raw.lastEvaluatedAt === "string" ? raw.lastEvaluatedAt : null,
      baselinedAt: typeof raw.baselinedAt === "number" ? raw.baselinedAt : null,
      pending: raw.pending && typeof raw.pending === "object" ? sanitizeNumberRecord(raw.pending) : {},
      restarts: raw.restarts && typeof raw.restarts === "object" ? sanitizeTimestampLists(raw.restarts) : {},
      restartCounts: raw.restartCounts && typeof raw.restartCounts === "object" ? sanitizeCountRecords(raw.restartCounts) : {},
      toggles: raw.toggles && typeof raw.toggles === "object" ? sanitizeTimestampLists(raw.toggles) : {},
      matchedAt: raw.matchedAt && typeof raw.matchedAt === "object" ? sanitizeNumberRecord(raw.matchedAt) : {},
      presentSince: raw.presentSince && typeof raw.presentSince === "object" ? sanitizeNumberRecord(raw.presentSince) : {},
    };
  } catch {
    globalStore.__incidentsState = fallback;
    console.warn("[incidents] state file unreadable — starting from a clean baseline");
  }
  return globalStore.__incidentsState;
}

function sanitizeNumberRecord(raw: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 200)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function sanitizeCountRecords(raw: Record<string, unknown>): Record<string, { count: number; at: number }> {
  const out: Record<string, { count: number; at: number }> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 200)) {
    const entry = value as { count?: unknown; at?: unknown };
    if (typeof entry?.count === "number" && typeof entry?.at === "number") {
      out[key] = { count: entry.count, at: entry.at };
    }
  }
  return out;
}

function sanitizeTimestampLists(raw: Record<string, unknown>, cap = 12): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [key, value] of Object.entries(raw).slice(0, 200)) {
    if (Array.isArray(value)) {
      const stamps = value.filter((entry): entry is number => typeof entry === "number").slice(-cap);
      if (stamps.length > 0) out[key] = stamps;
    }
  }
  return out;
}

/** Bounded history: cap recovered incidents by count and age. Active
 *  incidents are never pruned by this function. */export function pruneIncidents(
  incidents: Record<string, Incident>,
  now: number,
): Record<string, Incident> {
  const recovered = Object.values(incidents)
    .filter((incident) => incident.status === "recovered")
    .sort((a, b) => Date.parse(b.resolvedAt ?? b.lastSeenAt) - Date.parse(a.resolvedAt ?? a.lastSeenAt));
  const kept = new Set(
    recovered
      .filter((incident) => now - Date.parse(incident.resolvedAt ?? incident.lastSeenAt) <= INCIDENT_RECOVERY_RETENTION_MS)
      .slice(0, INCIDENT_RECOVERED_HISTORY_MAX)
      .map((incident) => incident.id),
  );
  const next: Record<string, Incident> = {};
  for (const [id, incident] of Object.entries(incidents)) {
    if (incident.status === "active" || kept.has(id)) next[id] = incident;
  }
  return next;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

/** Last persistence failure, for observability (diagnostics/bundle). */
export function lastIncidentsSaveError(): { message: string; at: string } | null {
  return globalStore.__incidentsSaveError ?? null;
}

export function scheduleIncidentsSave(delayMs = 1_000): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void saveIncidentsNow().catch(() => {});
  }, delayMs);
}

export async function saveIncidentsNow(): Promise<void> {
  const state = loadIncidentsState();
  state.incidents = pruneIncidents(state.incidents, Date.now());
  const path = incidentsStateFilePath();
  const startedAt = Date.now();
  try {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, path);
    globalStore.__incidentsSaveError = null;
    noteSourceAttempt("persistence", { ok: true, at: Date.now(), latencyMs: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalStore.__incidentsSaveError = { message, at: new Date().toISOString() };
    noteSourceAttempt("persistence", { ok: false, at: Date.now(), safeError: message });
    console.error("[incidents] state save failed:", message);
    throw error;
  }
}

/** Last successful persistence timestamp (diagnostics/bundle, Fase 25). */
export function lastSuccessfulPersistAt(): string | null {
  const record = globalStore.__incidentsState?.lastEvaluatedAt ?? null;
  return record;
}

/** Test hook. */
export function resetIncidentsStateCache(): void {
  globalStore.__incidentsState = null;
  globalStore.__incidentsSaveError = null;
  hydrationPromise = null;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}
