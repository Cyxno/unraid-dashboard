import type { Evidence, EvidenceType, Freshness, SourceId } from "@/lib/api-types";
import { freshnessOf } from "./freshness";

/**
 * Evidence builder (v1.5.0 Fase 4). Every incident proves itself through
 * evidence objects; the builder enforces the bounded, sanitized shape and
 * makes evidenceType explicit at the call site so causality language is
 * always a conscious choice:
 *
 *   direct      — the source states the fact literally (Docker says
 *                 health=unhealthy, Unraid says disk RED)
 *   derived     — computed from a rule over source values (CPU ≥ 85%
 *                 averaged 5m)
 *   correlated  — observed together, causality NOT proven (highest-CPU
 *                 container during a thermal event)
 *   unknown     — absence of proof (metrics unknown during an outage)
 *
 * No incident may claim a cause on correlated evidence alone: the UI and
 * notification copy use "correlated with" unless evidenceType=direct.
 */

export interface EvidenceInput {
  entity: string;
  signal: string;
  source: SourceId;
  /** ISO timestamp of the observation. */
  observedAt: string;
  /** Expected interval of the source, for freshness classification. */
  expectedIntervalMs?: number | null;
  value: string;
  rule?: string | null;
  evidenceType: EvidenceType;
  now?: number;
}

export function buildEvidence(input: EvidenceInput): Evidence {
  const freshness: Freshness = freshnessOf(input.observedAt, input.expectedIntervalMs ?? null, input.now ?? Date.now());
  const value = sanitizeEvidenceValue(input.value);
  return {
    entity: input.entity,
    signal: input.signal,
    source: input.source,
    observedAt: input.observedAt,
    freshness,
    value,
    rule: input.rule ?? null,
    evidenceType: input.evidenceType,
  };
}

/** Hard-caps and flattens evidence values (bounded payloads, no newlines). */
function sanitizeEvidenceValue(value: string, max = 160): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Human phrasing guard: correlated evidence must read as correlation. */
export function causalityPhrase(evidence: Evidence): string {
  return evidence.evidenceType === "direct" ? "proved by" : evidence.evidenceType === "correlated" ? "correlated with" : "indicated by";
}
