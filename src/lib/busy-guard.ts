"use client";

/**
 * Coarse busy-guard for deferred UI actions (§5): a controlled refresh
 * or service-worker activation must never land while a lifecycle action
 * is in flight, a confirmation dialog is open, or an update operation is
 * running. Components register busy scopes; the banner checks before it
 * offers/applies a refresh.
 */

const scopes = new Set<string>();
const listeners = new Set<() => void>();

export function setBusyScope(scope: string, busy: boolean): void {
  const changed = busy ? scopes.add(scope) : scopes.delete(scope);
  if (changed) {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // listener errors must not break registration
      }
    }
  }
}

export function isAnyBusyScope(): boolean {
  return scopes.size > 0;
}

export function onBusyChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
