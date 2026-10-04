"use strict";
/**
 * Helper inventory pipeline — pure, testable core (v1.3.13).
 *
 * Extracted from server.js so the exact failure class that silently
 * degraded production inventory (NDJSON parse, short/full id join,
 * stdout truncation, cache poisoning) is unit-testable and can never
 * ship red again. No docker access here: the caller executes docker
 * and feeds captured output into these functions.
 *
 * ContainerFact contract (additive; v1.3.12 consumers keep working):
 *   idShort         required  12-char lowercase hex (display id)
 *   idFull          optional  64-char lowercase hex (canonical identity)
 *   name, image     required  strings
 *   state, status   required  strings
 *   imageId         nullable  sha256:… of the running image
 *   repoDigests     required  string[] (may be empty — empty is NOT
 *                             evidence of a local build by itself)
 *   labels          required  object (subset of management-relevant keys)
 *   health          nullable
 *   networks        string[]  optional
 *   volumeSources   string[]  optional
 *   created         nullable
 *   unsupported     string[]  optional
 *   externallyManaged boolean optional
 *   snapshotPresent boolean   optional
 * Diagnostics are additive on the /inventory response body.
 */

const FULL_ID_RE = /^[a-f0-9]{64}$/;
const SHORT_ID_RE = /^[a-f0-9]{12}$/;

/** Full 64-char lowercase hex is the canonical identity. */
function isFullId(id) {
  return typeof id === "string" && FULL_ID_RE.test(id);
}

/** 12-char lowercase hex is a display/fallback id only. */
function isShortId(id) {
  return typeof id === "string" && SHORT_ID_RE.test(id);
}

/** Single id-normalization entry point (Fase 3): full id canonical,
 *  short id display. Malformed ids are rejected for identity mapping. */
function normalizeContainerId(id) {
  if (isFullId(id)) return { full: id, short: id.slice(0, 12), valid: true };
  if (isShortId(id)) return { full: null, short: id, valid: true };
  return { full: null, short: null, valid: false };
}

/**
 * Fase 1A/4: docker inspect with --format emits ONE JSON OBJECT PER LINE
 * (NDJSON), not a single document or array. Parse each line independently:
 * valid records survive a malformed line, and every failure is accounted
 * for — never silently dropped, never all-or-nothing.
 */
function parseInspectOutput(stdout) {
  const records = [];
  const parseErrors = [];
  const lines = String(stdout ?? "").split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (line.length === 0) continue; // trailing newline / blank lines
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed);
      } else {
        parseErrors.push({ line: index + 1, error: "not an object" });
      }
    } catch (error) {
      parseErrors.push({ line: index + 1, error: String(error.message).slice(0, 80) });
    }
  }
  return { records, parseErrors };
}

/**
 * Fase 1B/20/21/22: index inspect records by BOTH id forms.
 * `docker ps` prints short 12-char ids; inspect records carry the full
 * 64-char `.Id` — the historical silent-degradation root cause. Output
 * order is irrelevant: consumers join via this map, never via index.
 * Duplicates and malformed ids are counted, not silently overwritten.
 */
function buildIdIndex(records) {
  const byId = new Map();
  let malformed = 0;
  let duplicates = 0;
  for (const record of records) {
    const id = record?.Id;
    if (!isFullId(id)) {
      malformed += 1;
      continue;
    }
    const short = id.slice(0, 12);
    if (byId.has(id) || byId.has(short)) duplicates += 1;
    byId.set(id, record);
    byId.set(short, record);
  }
  return { byId, malformed, duplicates };
}

/** Fase 8: deterministic chunks for bounded batch inspect. */
function chunkList(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Fase 14: threshold-based structural validation. A real inventory ALWAYS
 * has image ids (docker reports `.Image` even for locally built images),
 * so near-zero imageId coverage proves pipeline degradation — independent
 * of registry facts. An all-local-build host can never false-positive.
 */
function assessInventory(containers, meta = {}) {
  const total = containers.length;
  const withImageId = containers.filter((c) => typeof c.imageId === "string" && c.imageId.length > 0).length;
  const withRepoDigests = containers.filter((c) => Array.isArray(c.repoDigests) && c.repoDigests.length > 0).length;
  const withLabels = containers.filter((c) => c.labels && Object.keys(c.labels).length > 0).length;
  const withFullId = containers.filter((c) => isFullId(c.idFull)).length;
  const pct = (n) => (total === 0 ? 0 : Math.round((n / total) * 100));
  const imageIdCoverage = pct(withImageId);
  const structurallyDegraded = total >= 3 && imageIdCoverage < 50;
  return {
    totalContainers: total,
    inspectedContainers: meta.inspectedContainers ?? total,
    inspectFailures: meta.inspectFailures ?? 0,
    parseErrors: meta.parseErrors ?? 0,
    imageIdCoverage,
    repoDigestCoverage: pct(withRepoDigests),
    labelCoverage: pct(withLabels),
    fullIdCoverage: pct(withFullId),
    partial: (meta.inspectFailures ?? 0) > 0 || (meta.parseErrors ?? 0) > 0,
    structurallyDegraded,
    chunks: meta.chunks ?? 1,
    durationMs: meta.durationMs ?? null,
    lastSuccessfulRefresh: meta.lastSuccessfulRefresh ?? null,
  };
}

/**
 * Fase 11: a failed refresh must NEVER replace a good cache with an empty
 * dataset. Policy: full/partial success → replace; hard failure → serve
 * last-known-good + degraded marker; no previous good → explicit empty
 * with degraded (never a fabricated healthy inventory).
 */
function nextInventoryCache(previous, refreshResult) {
  if (refreshResult.ok) {
    return { body: refreshResult.body, at: refreshResult.at, degraded: refreshResult.partial === true, lastGoodAt: refreshResult.at };
  }
  if (previous?.body) {
    return { body: previous.body, at: previous.at, degraded: true, lastGoodAt: previous.at };
  }
  return {
    body: { version: refreshResult.version ?? null, containers: [], storage: refreshResult.storage ?? { mode: "unknown", source: null }, diagnostics: { totalContainers: 0, structurallyDegraded: false, degraded: true, reason: "refresh failed" } },
    at: refreshResult.at,
    degraded: true,
    lastGoodAt: null,
  };
}

/** Fase 30: one aggregate line per refresh — no per-container noise. */
function refreshLogLine(diagnostics) {
  return `inventory refresh: containers=${diagnostics.totalContainers} chunks=${diagnostics.chunks} parsed=${diagnostics.inspectedContainers} failed=${diagnostics.inspectFailures} parseErrors=${diagnostics.parseErrors} imageId=${diagnostics.imageIdCoverage}% digests=${diagnostics.repoDigestCoverage}% labels=${diagnostics.labelCoverage}% partial=${diagnostics.partial} degraded=${diagnostics.structurallyDegraded} duration=${diagnostics.durationMs}ms`;
}

module.exports = {
  isFullId,
  isShortId,
  normalizeContainerId,
  parseInspectOutput,
  buildIdIndex,
  chunkList,
  assessInventory,
  nextInventoryCache,
  refreshLogLine,
};
