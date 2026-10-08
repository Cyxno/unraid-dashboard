import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getEnvSafe } from "@/server/env";
import type { Insight } from "@/lib/api-types";
import { noteSourceAttempt } from "@/server/incidents/source-health";

/**
 * Insight state persistence (v1.6.0 Fase 15/21).
 *
 * Persists ONLY the derived metadata needed for stable identity across
 * restarts: fingerprint → firstObserved/lastObserved (+ severity for the
 * notification dedupe). Prometheus owns the samples; Beacon never stores
 * trend history. Bounded at 200 fingerprints.
 */

export interface InsightIdentityState {
  version: 1;
  identities: Record<string, { firstObserved: string; lastObserved: string; severity: string; title: string }>;
  lastEvaluatedAt: string | null;
  /** Opt-in (Fase 25): push only these explicit classes, default OFF. */
  pushPreferences: {
    capacityCriticalSoon: boolean;
    extremePersistentDegradation: boolean;
  };
}

const globalStore = globalThis as unknown as {
  __insightsState?: InsightIdentityState | null;
  __insightsSaveError?: { message: string; at: string } | null;
};

const IDENTITIES_MAX = 200;

export function insightsStateFilePath(): string {
  return join(getEnvSafe().AUDIT_DIR, "insights-state.json");
}

function emptyState(): InsightIdentityState {
  return {
    version: 1,
    identities: {},
    lastEvaluatedAt: null,
    pushPreferences: { capacityCriticalSoon: false, extremePersistentDegradation: false },
  };
}

export function loadInsightsState(): InsightIdentityState {
  if (globalStore.__insightsState) return globalStore.__insightsState;
  globalStore.__insightsState = emptyState();
  return globalStore.__insightsState;
}

let hydrationPromise: Promise<InsightIdentityState> | null = null;

export function ensureInsightsState(): Promise<InsightIdentityState> {
  if (globalStore.__insightsState) return Promise.resolve(globalStore.__insightsState);
  hydrationPromise ??= loadInsightsStateFromDisk();
  return hydrationPromise;
}

export async function loadInsightsStateFromDisk(): Promise<InsightIdentityState> {
  if (globalStore.__insightsState) return globalStore.__insightsState;
  const fallback = emptyState();
  try {
    const raw = JSON.parse(await readFile(insightsStateFilePath(), "utf8")) as Partial<InsightIdentityState>;
    const identities: InsightIdentityState["identities"] = {};
    if (raw.identities && typeof raw.identities === "object") {
      for (const [id, entry] of Object.entries(raw.identities).slice(0, IDENTITIES_MAX)) {
        if (entry && typeof entry.firstObserved === "string" && typeof entry.lastObserved === "string") {
          identities[id] = entry;
        }
      }
    }
    globalStore.__insightsState = {
      version: 1,
      identities,
      lastEvaluatedAt: typeof raw.lastEvaluatedAt === "string" ? raw.lastEvaluatedAt : null,
      pushPreferences: {
        capacityCriticalSoon: raw.pushPreferences?.capacityCriticalSoon === true,
        extremePersistentDegradation: raw.pushPreferences?.extremePersistentDegradation === true,
      },
    };
  } catch {
    globalStore.__insightsState = fallback;
  }
  return globalStore.__insightsState;
}

/** Merges the fresh insight identities into the persisted state (bounded). */
export function mergeInsightIdentities(insights: Insight[]): void {
  const state = loadInsightsState();
  for (const insight of insights) {
    state.identities[insight.id] = {
      firstObserved: insight.firstObserved,
      lastObserved: insight.lastObserved,
      severity: insight.severity,
      title: insight.title,
    };
  }
  // Prune: keep the most recently observed 200 identities.
  const sorted = Object.entries(state.identities).sort(
    (a, b) => Date.parse(b[1].lastObserved) - Date.parse(a[1].lastObserved),
  );
  state.identities = Object.fromEntries(sorted.slice(0, IDENTITIES_MAX));
  state.lastEvaluatedAt = new Date().toISOString();
}

/** Applies stable firstObserved from persisted identities (dedupe). */
export function applyStableIdentity(insight: Insight): void {
  const state = loadInsightsState();
  const known = state.identities[insight.id];
  if (known) {
    insight.firstObserved = known.firstObserved;
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

export function lastInsightsSaveError(): { message: string; at: string } | null {
  return globalStore.__insightsSaveError ?? null;
}

export function scheduleInsightsStateSave(delayMs = 2_000): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void saveInsightsStateNow().catch(() => {});
  }, delayMs);
}

export async function saveInsightsStateNow(): Promise<void> {
  const state = loadInsightsState();
  const path = insightsStateFilePath();
  const startedAt = Date.now();
  try {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, path);
    globalStore.__insightsSaveError = null;
    noteSourceAttempt("persistence", { ok: true, at: Date.now(), latencyMs: Date.now() - startedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    globalStore.__insightsSaveError = { message, at: new Date().toISOString() };
    console.error("[insights] state save failed:", message);
  }
}

export function setInsightPushPreference(key: keyof InsightIdentityState["pushPreferences"], value: boolean): void {
  const state = loadInsightsState();
  state.pushPreferences[key] = value;
  scheduleInsightsStateSave();
}

export function getInsightPushPreferences(): InsightIdentityState["pushPreferences"] {
  return loadInsightsState().pushPreferences;
}

export function resetInsightsStateCache(): void {
  globalStore.__insightsState = null;
  globalStore.__insightsSaveError = null;
  hydrationPromise = null;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}
