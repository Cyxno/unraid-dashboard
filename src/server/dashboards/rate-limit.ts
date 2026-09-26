/**
 * Minimal sliding-window write limiter for shared-dashboard mutations.
 * Single-instance deployment, so an in-process map is sufficient.
 * Deliberately separate from the action-policy limiter: dashboard edits
 * are cheap metadata writes, not lifecycle actions.
 */

const WINDOW_MS = 60_000;
const MAX_WRITES_PER_MINUTE = 30;

const globalStore = globalThis as unknown as {
  __dashboardWriteLimit?: Map<string, { count: number; windowStart: number }>;
};

function state(): Map<string, { count: number; windowStart: number }> {
  if (!globalStore.__dashboardWriteLimit) {
    globalStore.__dashboardWriteLimit = new Map();
  }
  return globalStore.__dashboardWriteLimit;
}

export function checkWriteRate(actor: string, now = Date.now()): { allowed: boolean; retryAfterMs?: number } {
  const store = state();
  const window = store.get(actor);
  if (!window || now - window.windowStart >= WINDOW_MS) {
    store.set(actor, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (window.count >= MAX_WRITES_PER_MINUTE) {
    return { allowed: false, retryAfterMs: WINDOW_MS - (now - window.windowStart) };
  }
  window.count += 1;
  return { allowed: true };
}

/** Periodic cleanup (called opportunistically). */
export function pruneWriteLimit(now = Date.now()): void {
  const store = state();
  for (const [key, window] of store) {
    if (now - window.windowStart > 3_600_000) store.delete(key);
  }
}

/** Test hook. */
export function resetWriteLimit(): void {
  globalStore.__dashboardWriteLimit = undefined;
}
