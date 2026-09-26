import { timingSafeEqual } from "node:crypto";
import { getEnvSafe } from "@/server/env";
import { getBuildInfo } from "@/server/version";

/**
 * Client for the local update helper (v0.7).
 *
 * The helper is the ONLY component with Docker access: it binds
 * 127.0.0.1, accepts a single validated operation (update container
 * `unraid-dashboard` from the pinned repo to a semver tag), and runs a
 * phase machine with automatic rollback. This module is the dashboard's
 * only path to it; the helper token never leaves the server process.
 *
 * Without UPDATE_HELPER_URL/UPDATE_HELPER_TOKEN every function degrades
 * to "unavailable" with a reason — the rest of the app is unaffected.
 */

export interface UpdateHelperStatus {
  configured: boolean;
  reachable: boolean | null;
  reason: string | null;
  helperVersion: string | null;
  phase: string | null;
  detail: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  log: Array<{ at: string; phase: string; detail: string }>;
  lock: { since: string } | null;
  lastUpdate: {
    from: string;
    to: string;
    result: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    digest?: string | null;
    usedLocalImage?: boolean;
    error?: string;
  } | null;
  currentImage: string | null;
  currentVersion: string | null;
  currentRevision: string | null;
  currentImageId: string | null;
  localVersions: string[];
  pullAvailable: boolean | null;
}

const UPDATE_PHASES = new Set([
  "requested",
  "checking",
  "pulling",
  "validating",
  "replacing",
  "healthchecking",
  "verifying",
]);

/** True while the helper's update machine is actively running. */
export function isUpdatePhaseActive(phase: string | null): boolean {
  return phase !== null && UPDATE_PHASES.has(phase);
}

function helperConfig(): { url: string; token: string | null } | null {
  const env = getEnvSafe();
  if (!env.UPDATE_HELPER_URL) return null;
  return { url: env.UPDATE_HELPER_URL, token: env.UPDATE_HELPER_TOKEN ?? null };
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export async function getHelperStatus(): Promise<UpdateHelperStatus> {
  const config = helperConfig();
  if (!config) {
    return {
      configured: false,
      reachable: null,
      reason: "Update helper not configured (UPDATE_HELPER_URL missing). Updates run host-side via scripts/update-dashboard.sh.",
      helperVersion: null,
      phase: null,
      detail: null,
      startedAt: null,
      finishedAt: null,
      log: [],
      lock: null,
      lastUpdate: null,
      currentImage: null,
      currentVersion: null,
      currentRevision: null,
      currentImageId: null,
      localVersions: [],
      pullAvailable: null,
    };
  }
  try {
    const response = await fetch(`${config.url}/status`, {
      signal: AbortSignal.timeout(4_000),
      cache: "no-store",
    });
    if (!response.ok) {
      return unavailable(`Helper responded with HTTP ${response.status}.`, config.url);
    }
    const body = (await response.json()) as Partial<UpdateHelperStatus>;
    return {
      configured: true,
      reachable: true,
      reason: null,
      helperVersion: body.helperVersion ?? null,
      phase: body.phase ?? null,
      detail: body.detail ?? null,
      startedAt: body.startedAt ?? null,
      finishedAt: body.finishedAt ?? null,
      log: body.log ?? [],
      lock: body.lock ?? null,
      lastUpdate: body.lastUpdate ?? null,
      currentImage: body.currentImage ?? null,
      currentVersion: body.currentVersion ?? null,
      currentRevision: body.currentRevision ?? null,
      currentImageId: body.currentImageId ?? null,
      localVersions: body.localVersions ?? [],
      pullAvailable: body.pullAvailable ?? null,
    };
  } catch (error) {
    return unavailable(error instanceof Error ? error.message : "helper unreachable", config.url);
  }
}

function unavailable(reason: string, url: string): UpdateHelperStatus {
  void url;
  return {
    configured: true,
    reachable: false,
    reason,
    helperVersion: null,
    phase: null,
    detail: null,
    startedAt: null,
    finishedAt: null,
    log: [],
    lock: null,
    lastUpdate: null,
    currentImage: null,
    currentVersion: null,
    currentRevision: null,
    currentImageId: null,
    localVersions: [],
    pullAvailable: null,
  };
}

export interface UpdateRequestResult {
  accepted: boolean;
  status: number;
  reason?: string;
  /** True when an operation was already running and the request attached. */
  attached?: boolean;
  phase?: string | null;
}

/** Requests an update to a validated semver tag. Audited by the caller. */
export async function requestUpdate(rawTag: string): Promise<UpdateRequestResult> {
  const config = helperConfig();
  if (!config) {
    return { accepted: false, status: 503, reason: "Update helper not configured." };
  }
  if (!config.token) {
    return { accepted: false, status: 503, reason: "UPDATE_HELPER_TOKEN not configured on the dashboard." };
  }
  const tag = rawTag.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(tag)) {
    return { accepted: false, status: 400, reason: "Invalid tag — semantic version required." };
  }
  // Refuse self-version requests that are not newer (helper re-verifies too).
  const running = getBuildInfo().version;
  const compare = compareSemver(tag, running);
  if (compare <= 0) {
    return {
      accepted: false,
      status: 400,
      reason:
        compare === 0
          ? "Requested tag equals the running version — use the helper's same-version validation path explicitly if needed."
          : "Requested tag is older than the running version.",
    };
  }
  // Attach semantics: when a machine is already running, the client
  // attaches to it instead of erroring (the status poll carries progress).
  const status = await getHelperStatus();
  if (status.reachable && isUpdatePhaseActive(status.phase)) {
    return { accepted: false, status: 200, reason: "attach", attached: true, phase: status.phase ?? null };
  }
  try {
    const response = await fetch(`${config.url}/update`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tag }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string; accepted?: boolean };
    if (response.status === 202 && body.accepted) {
      return { accepted: true, status: 202 };
    }
    return {
      accepted: false,
      status: response.status,
      reason: body.error ?? `Helper responded with HTTP ${response.status}.`,
    };
  } catch (error) {
    return {
      accepted: false,
      status: 502,
      reason: error instanceof Error ? error.message : "Helper request failed.",
    };
  }
}

/**
 * Requests a rollback to a previously validated local release. The helper
 * allowlists the tag: the image must exist locally and its OCI version
 * label must match — no arbitrary refs.
 */
export async function requestRollback(tag: string): Promise<UpdateRequestResult> {
  const config = helperConfig();
  if (!config) return { accepted: false, status: 503, reason: "Update helper not configured." };
  if (!config.token) return { accepted: false, status: 503, reason: "UPDATE_HELPER_TOKEN not configured." };
  const clean = tag.trim().replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(clean)) {
    return { accepted: false, status: 400, reason: "Invalid tag — semantic version required." };
  }
  try {
    const response = await fetch(`${config.url}/rollback`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ tag: clean }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string; accepted?: boolean };
    if (response.status === 202 && body.accepted) return { accepted: true, status: 202 };
    return {
      accepted: false,
      status: response.status,
      reason: body.error ?? `Helper responded with HTTP ${response.status}.`,
    };
  } catch (error) {
    return { accepted: false, status: 502, reason: error instanceof Error ? error.message : "Helper request failed." };
  }
}

/** Explicit same-version validation transition (helper-level smoke test). */
export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const diff = (pa[index] ?? 0) - (pb[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Shared-secret check for the proxy-auth boundary (v0.7). */
export function proxySecretMatches(headerValue: string | null): boolean {
  const env = getEnvSafe();
  if (!env.AUTH_PROXY_SECRET) return false; // fail closed when unset
  if (!headerValue) return false;
  return constantTimeEqual(headerValue, env.AUTH_PROXY_SECRET);
}

/** Test hooks. */
export function resetHelperClientCaches(): void {
  // Reserved for future memoization.
}
