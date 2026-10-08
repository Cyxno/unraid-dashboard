import type { Freshness, SourceHealth, SourceHealthStatus, SourceId } from "@/lib/api-types";
import { classifyFreshness, expectedIntervalFor } from "./freshness";

/**
 * Canonical source-health registry (v1.5.0 Fase 2).
 *
 * Every signal path (Unraid sections, Prometheus domains, helper
 * inventory, web-push delivery, persistence saves) reports attempts here.
 * The registry derives per-source status WITHOUT trusting the caller's
 * optimism: a source whose last successful observation is too old is
 * never reported healthy, even when no explicit failure was recorded
 * ("geen bron mag stil healthy zijn").
 *
 * In-memory only — this is live observability, not durable state. The
 * durable artifact is the incident registry (store.ts).
 */

export interface SourceAttempt {
  ok: boolean;
  at: number;
  latencyMs?: number | null;
  /** Already-sanitized error (callers must never pass raw upstream text). */
  safeError?: string | null;
  detail?: string | null;
}

interface SourceRecord {
  lastSuccess: { at: number; latencyMs: number | null } | null;
  lastAttempt: { at: number; ok: boolean; safeError: string | null; latencyMs: number | null } | null;
  /** Free-form short detail from the last attempt (e.g. degraded mode). */
  detail: string | null;
  /** Expected interval override when a source deviates from the table. */
  expectedIntervalMs: number | null;
}

const globalStore = globalThis as unknown as {
  __incidentSourceHealth?: Map<SourceId, SourceRecord>;
};

function records(): Map<SourceId, SourceRecord> {
  if (!globalStore.__incidentSourceHealth) {
    globalStore.__incidentSourceHealth = new Map();
  }
  return globalStore.__incidentSourceHealth;
}

function recordFor(source: SourceId): SourceRecord {
  const map = records();
  let record = map.get(source);
  if (!record) {
    record = {
      lastSuccess: null,
      lastAttempt: null,
      detail: null,
      expectedIntervalMs: expectedIntervalFor(source),
    };
    map.set(source, record);
  }
  return record;
}

/** Records an observation attempt. `safeError` must be pre-sanitized. */
export function noteSourceAttempt(source: SourceId, attempt: SourceAttempt): void {
  const record = recordFor(source);
  const latencyMs = attempt.latencyMs ?? null;
  if (attempt.ok) {
    record.lastSuccess = { at: attempt.at, latencyMs };
    record.lastAttempt = { at: attempt.at, ok: true, safeError: null, latencyMs };
    if (attempt.detail !== undefined) record.detail = attempt.detail;
  } else {
    record.lastAttempt = {
      at: attempt.at,
      ok: false,
      safeError: attempt.safeError ?? "unavailable",
      latencyMs,
    };
    if (attempt.detail !== undefined) record.detail = attempt.detail;
  }
}

/** Overrides the expected-interval contract (e.g. per-section TTLs). */
export function setSourceInterval(source: SourceId, intervalMs: number): void {
  recordFor(source).expectedIntervalMs = intervalMs;
}

export interface SourceHealthInput {
  source: SourceId;
  /** Status to force regardless of record (e.g. "not configured"). */
  statusOverride?: SourceHealthStatus | null;
  detailOverride?: string | null;
  now?: number;
  /** Age threshold beyond which a source with old data reads "stale". */
  staleAfterMs?: number;
}

/**
 * Derives the health entry for one source. Status logic:
 * - unavailable: last attempt failed AND no last-known-good success, or
 *   status override.
 * - degraded: last attempt failed but last-known-good data is being
 *   served, OR the caller marked a partial result.
 * - stale: no recent failure, but the last success is past the freshness
 *   band (silent aging — the core "no false healthy" rule).
 * - healthy otherwise.
 */
export function getSourceHealth(input: SourceHealthInput): SourceHealth {
  const { source } = input;
  const record = records().get(source);
  const now = input.now ?? Date.now();
  const interval = record?.expectedIntervalMs ?? expectedIntervalFor(source);

  const lastSuccessAt = record?.lastSuccess ? new Date(record.lastSuccess.at).toISOString() : null;
  const lastAttemptAt = record?.lastAttempt ? new Date(record.lastAttempt.at).toISOString() : null;
  const ageMs = record?.lastSuccess ? now - record.lastSuccess.at : null;
  const freshness: Freshness = ageMs == null ? "unknown" : classifyFreshness(ageMs, interval);

  let status: SourceHealthStatus;
  if (input.statusOverride) {
    status = input.statusOverride;
  } else if (!record) {
    status = "unavailable"; // never observed: not healthy by definition
  } else if (record.lastAttempt && !record.lastAttempt.ok) {
    status = record.lastSuccess ? "degraded" : "unavailable";
    // A long-ago success with a failing present is still degraded, but if
    // the LKG data itself has gone past stale, say "stale" — sharper than
    // "degraded" for consumers deciding whether to trust values.
    if (status === "degraded" && freshness === "stale") status = "stale";
  } else if (freshness === "stale" || (input.staleAfterMs != null && ageMs != null && ageMs > input.staleAfterMs)) {
    status = "stale";
  } else {
    status = "healthy";
  }

  return {
    source,
    status,
    lastSuccessAt,
    lastAttemptAt,
    ageMs,
    expectedIntervalMs: interval,
    latencyMs: record?.lastAttempt?.latencyMs ?? record?.lastSuccess?.latencyMs ?? null,
    safeError: record?.lastAttempt && !record.lastAttempt.ok ? record.lastAttempt.safeError : null,
    freshness,
    detail: input.detailOverride ?? record?.detail ?? null,
  };
}

export function getAllSourceHealth(now: number = Date.now()): SourceHealth[] {
  const sources: SourceId[] = [
    "unraid-api",
    "prometheus",
    "cadvisor",
    "node-exporter",
    "helper",
    "docker-inventory",
    "web-push",
    "persistence",
    "beacon-update",
  ];
  return sources.map((source) => getSourceHealth({ source, now }));
}

/** True when the source currently proves fresh-enough data (Fase 8). */
export function isSourceUsable(source: SourceId, now: number = Date.now()): boolean {
  const health = getSourceHealth({ source, now });
  return health.status === "healthy" || health.status === "degraded";
}

/** Test hook: clears the registry. */
export function resetSourceHealth(): void {
  globalStore.__incidentSourceHealth = undefined;
}
