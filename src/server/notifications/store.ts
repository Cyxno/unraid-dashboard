import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getEnvSafe } from "@/server/env";
import {
  DEFAULT_PREFERENCES,
  type NotificationState,
  type PushSubscriptionRecord,
} from "./types";

/**
 * Persistence for the notification system: one JSON file under /app/data
 * (same durability model as update history and shared dashboards). Writes
 * are atomic (temp file + rename); the in-memory copy is the working set
 * and is persisted debounced by the engine.
 */

const MAX_HISTORY = 250;

const globalStore = globalThis as unknown as {
  __notificationState?: NotificationState | null;
  __notificationSaveError?: { message: string; at: string } | null;
};

export function stateFilePath(): string {
  return join(getEnvSafe().AUDIT_DIR, "notifications-state.json");
}

function emptyState(): NotificationState {
  return {
    version: 1,
    preferences: structuredClone(DEFAULT_PREFERENCES),
    active: {},
    subscriptions: [],
    history: [],
    lastId: 0,
    baselinedAt: null,
  };
}

export function loadState(): NotificationState {
  if (globalStore.__notificationState) return globalStore.__notificationState;
  globalStore.__notificationState = emptyState();
  return globalStore.__notificationState;
}

let hydrationPromise: Promise<NotificationState> | null = null;

/**
 * Boot-safe hydration: the FIRST state touch (route request or engine cycle)
 * must read the disk file before any mutation happens. The sync loadState()
 * above would initialize an empty global when a request lands before the
 * engine's first cycle (t+15s after boot) — loadStateFromDisk() then returns
 * that empty global and the baseline save OVERWRITES the persisted file.
 * Every state consumer awaits this instead; hydration runs at most once.
 */
export function ensureNotificationState(): Promise<NotificationState> {
  if (globalStore.__notificationState) return Promise.resolve(globalStore.__notificationState);
  hydrationPromise ??= loadStateFromDisk();
  return hydrationPromise;
}

export async function loadStateFromDisk(): Promise<NotificationState> {
  if (globalStore.__notificationState) return globalStore.__notificationState;
  const fallback = emptyState();
  try {
    const raw = JSON.parse(await readFile(stateFilePath(), "utf8")) as Partial<NotificationState>;
    globalStore.__notificationState = {
      version: 1,
      preferences: { ...fallback.preferences, ...(raw.preferences ?? {}) },
      active: raw.active && typeof raw.active === "object" ? raw.active : {},
      subscriptions: Array.isArray(raw.subscriptions)
        ? raw.subscriptions.filter((entry): entry is PushSubscriptionRecord => Boolean(entry?.endpoint && entry?.keys))
        : [],
      history: Array.isArray(raw.history) ? raw.history.slice(-MAX_HISTORY) : [],
      lastId: Number(raw.lastId) || 0,
      baselinedAt: typeof raw.baselinedAt === "number" ? raw.baselinedAt : null,
    };
  } catch {
    // Corrupt or unreadable state: recover to a fresh baseline instead of
    // crashing the app. Worst case, notification dedupe/history resets —
    // and the engine's baseline mode prevents a recovery storm.
    globalStore.__notificationState = fallback;
    console.warn("[notifications] state file unreadable — starting from a clean baseline");
  }
  return globalStore.__notificationState;
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

/** Last persistence failure, for observability (API/diagnostics). */
export function lastSaveError(): { message: string; at: string } | null {
  return globalStore.__notificationSaveError ?? null;
}

/** Persist soon (debounced) — the engine calls this after mutations. */
export function scheduleSave(delayMs = 500): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    void saveNow().catch(() => {});
  }, delayMs);
}

export async function saveNow(): Promise<void> {
  const state = loadState();
  state.history = state.history.slice(-MAX_HISTORY);
  const path = stateFilePath();
  try {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, path);
    globalStore.__notificationSaveError = null;
  } catch (error) {
    // Persistence failure must never be silent: the in-memory state keeps
    // serving, but a container recreate would lose everything since the
    // last successful save — that has to be visible in logs and diagnostics.
    globalStore.__notificationSaveError = {
      message: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
    console.error(
      "[notifications] state save failed:",
      globalStore.__notificationSaveError.message,
    );
    throw error;
  }
}

/** Test hook. */
export function resetStateCache(): void {
  globalStore.__notificationState = null;
  globalStore.__notificationSaveError = null;
  hydrationPromise = null;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}
