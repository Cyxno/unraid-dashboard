"use client";

/**
 * Auth-session state (v0.7.2).
 *
 * Behind the Authelia forward-auth proxy an expired session surfaces as an
 * API response that followed a redirect to the Authelia portal — the fetch
 * resolves with HTML instead of JSON (or a 401 on direct calls). When that
 * is detected the app enters "auth expired" state: polling loops pause
 * (no infinite retry storms), a clear full-screen sign-in card replaces
 * the stale UI, and a light probe auto-recovers the moment the session is
 * valid again.
 */

type Listener = () => void;

let expired = false;
let lastAliveAt: number | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // listener errors must not break state transitions
    }
  }
}

export function markAuthExpired(): void {
  if (!expired) {
    expired = true;
    emit();
  }
}

export function markAuthAlive(): void {
  lastAliveAt = Date.now();
  if (expired) {
    expired = false;
    emit();
  }
}

export function isAuthExpired(): boolean {
  return expired;
}

export function getLastAuthAliveAt(): number | null {
  return lastAliveAt;
}

export function onAuthChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Classifies a fetch response as "session expired": the proxy redirected
 * to the Authelia portal (HTML answer for an API path) or answered 401.
 */
export function isAuthExpiredResponse(response: Response): boolean {
  if (response.status === 401) return true;
  const contentType = response.headers.get("content-type") ?? "";
  return (
    (response.redirected || !response.url.includes(location.origin)) &&
    contentType.includes("text/html")
  );
}

/** Probes /api/version; returns true when the session is valid again. */
export async function probeAuthAlive(): Promise<boolean> {
  try {
    const response = await fetch("/api/version", { cache: "no-store" });
    if (response.ok) {
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("application/json")) {
        markAuthAlive();
        return true;
      }
    }
    markAuthExpired();
    return false;
  } catch {
    // network-level failure is NOT an auth problem
    return !isAuthExpired();
  }
}
