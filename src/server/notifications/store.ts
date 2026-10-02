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
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, path);
}

/** Test hook. */
export function resetStateCache(): void {
  globalStore.__notificationState = null;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
}
