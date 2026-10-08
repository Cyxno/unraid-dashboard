import type { Freshness } from "@/lib/api-types";
import {
  FRESHNESS_AGING_FLOOR_MS,
  FRESHNESS_FRESH_FLOOR_MS,
  SOURCE_EXPECTED_INTERVAL_MS,
} from "@/server/thresholds";

/**
 * Canonical freshness classification (v1.5.0 Fase 3).
 *
 * The ONLY place in the codebase allowed to compare a data age against a
 * staleness threshold. Every consumer classifies through here so a 5s
 * poll source and a 15m SMART/temperature source get logically different
 * stale bands and no module invents its own `Date.now() - ts > …` rule.
 *
 * Bands (relative to the source's own expected interval, floored so
 * scheduler jitter on fast sources cannot flap freshness):
 *   fresh   age ≤ max(2×interval, 10s)
 *   aging   age ≤ max(6×interval, 60s)  — usable, refresh is overdue
 *   stale   beyond aging                — must never read as healthy
 *   unknown no observation at all
 */

export function classifyFreshness(ageMs: number | null | undefined, expectedIntervalMs: number | null | undefined): Freshness {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  if (expectedIntervalMs == null || !Number.isFinite(expectedIntervalMs) || expectedIntervalMs <= 0) {
    // Without an interval contract the safest honest band for old data is
    // "stale" once it is no longer fresh by the absolute floor.
    return ageMs <= FRESHNESS_FRESH_FLOOR_MS ? "fresh" : ageMs <= FRESHNESS_AGING_FLOOR_MS ? "aging" : "stale";
  }
  const freshBand = Math.max(2 * expectedIntervalMs, FRESHNESS_FRESH_FLOOR_MS);
  const agingBand = Math.max(6 * expectedIntervalMs, FRESHNESS_AGING_FLOOR_MS);
  if (ageMs <= freshBand) return "fresh";
  if (ageMs <= agingBand) return "aging";
  return "stale";
}

/** Interval contract for a canonical source id (null when unknown). */
export function expectedIntervalFor(source: keyof typeof SOURCE_EXPECTED_INTERVAL_MS | string): number | null {
  return SOURCE_EXPECTED_INTERVAL_MS[source] ?? null;
}

/** Freshness of an ISO timestamp seen from `now` (default: real clock). */
export function freshnessOf(isoTimestamp: string | null | undefined, expectedIntervalMs: number | null | undefined, now: number = Date.now()): Freshness {
  if (!isoTimestamp) return "unknown";
  const at = Date.parse(isoTimestamp);
  if (Number.isNaN(at)) return "unknown";
  return classifyFreshness(now - at, expectedIntervalMs);
}
