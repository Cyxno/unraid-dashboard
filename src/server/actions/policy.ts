import { getEnv } from "@/server/env";

/**
 * In-process action policy: cooldowns per (kind, id, action), a per-actor
 * rate cap, and mutual exclusion of concurrent actions on the same target.
 * Deliberately simple — this is a single-instance deployment.
 */

const globalStore = globalThis as unknown as {
  __dashboardActionPolicy?: {
    lastActionAt: Map<string, number>;
    windows: Map<string, { count: number; windowStart: number }>;
    inFlight: Map<string, Promise<unknown>>;
  };
};

function state() {
  if (!globalStore.__dashboardActionPolicy) {
    globalStore.__dashboardActionPolicy = {
      lastActionAt: new Map(),
      windows: new Map(),
      inFlight: new Map(),
    };
  }
  return globalStore.__dashboardActionPolicy;
}

export type PolicyDecision =
  | { allowed: true; release: () => void }
  | { allowed: false; reason: string; retryAfterMs?: number };

/** Cooldown key for a specific target+action. */
export function cooldownKey(kind: string, id: string, action: string): string {
  return `${kind}:${id}:${action}`;
}

/** Any-action key for a target (mutual exclusion). */
export function targetKey(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/**
 * Check + reserve capacity for an action. Call `release()` when the
 * action finishes (success or failure) to clear mutual exclusion.
 */
export function reserveAction(
  actor: string,
  kind: string,
  id: string,
  action: string,
  now = Date.now(),
): PolicyDecision {
  const env = getEnv();
  const store = state();

  // 1. Rate cap per actor (user or IP) in a sliding 60s window.
  const windowMs = 60_000;
  const window = store.windows.get(actor);
  if (!window || now - window.windowStart >= windowMs) {
    store.windows.set(actor, { count: 1, windowStart: now });
  } else if (window.count >= env.ACTION_RATE_PER_MINUTE) {
    return {
      allowed: false,
      reason: `Rate limit: at most ${env.ACTION_RATE_PER_MINUTE} actions per minute.`,
      retryAfterMs: windowMs - (now - window.windowStart),
    };
  } else {
    window.count += 1;
  }

  // 2. Cooldown per target+action.
  const last = store.lastActionAt.get(cooldownKey(kind, id, action));
  if (last !== undefined && now - last < env.ACTION_COOLDOWN_MS) {
    return {
      allowed: false,
      reason: `Cooldown: '${action}' on this target was issued ${Math.round(
        (now - last) / 1000,
      )}s ago (min ${Math.round(env.ACTION_COOLDOWN_MS / 1000)}s).`,
      retryAfterMs: env.ACTION_COOLDOWN_MS - (now - last),
    };
  }

  // 3. Mutual exclusion per target (any action).
  const tKey = targetKey(kind, id);
  if (store.inFlight.has(tKey)) {
    return {
      allowed: false,
      reason: "Another action on this target is already in progress.",
    };
  }

  store.lastActionAt.set(cooldownKey(kind, id, action), now);
  store.inFlight.set(
    tKey,
    new Promise(() => {}), // placeholder replaced on release
  );

  return {
    allowed: true,
    release: () => {
      store.inFlight.delete(tKey);
    },
  };
}

/** Whether a target currently has an action in flight (UI polling aid). */
export function isActionInFlight(kind: string, id: string): boolean {
  return state().inFlight.has(targetKey(kind, id));
}

/** Test hook + periodic cleanup: drop state older than an hour. */
export function prunePolicy(now = Date.now()): void {
  const store = state();
  for (const [key, at] of store.lastActionAt) {
    if (now - at > 3_600_000) store.lastActionAt.delete(key);
  }
  for (const [key, window] of store.windows) {
    if (now - window.windowStart > 3_600_000) store.windows.delete(key);
  }
}

/** Test hook: reset all policy state. */
export function resetPolicy(): void {
  globalStore.__dashboardActionPolicy = {
    lastActionAt: new Map(),
    windows: new Map(),
    inFlight: new Map(),
  };
}
