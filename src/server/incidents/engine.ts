import type {
  Evidence,
  HealthSummary,
  Incident,
  IncidentSeverity,
  ObservabilityConfidence,
  TimelineEvent,
} from "@/lib/api-types";
import {
  CONTAINER_UNHEALTHY_CRITICAL_AFTER_MS,
  CRASH_LOOP_WINDOW_MS,
  FLAP_MIN_TRANSITIONS,
  FLAP_RECOVERY_STABLE_MS,
  FLAP_WINDOW_MS,
  INCIDENT_EVIDENCE_MAX,
  INCIDENT_IMPACT_MAX,
  INCIDENT_TIMELINE_MAX,
} from "@/server/thresholds";
import { SEVERITY_POLICY, SEVERITY_RANK, severityToHealthLevel } from "./severity";
import { evaluateRules, type RuleCandidate } from "./rules";
import type { IncidentObservation } from "./observe";
import type { IncidentsState } from "./store";
import type { EventCategory, RawEvent } from "@/server/notifications/types";

/**
 * Incident engine (v1.5.0 Fase 5/6/11/12/13/14).
 *
 * Pure state machine over (observation, persisted state): rules produce
 * candidates, the engine owns lifecycle. Design guarantees:
 *
 * - Lifecycle: OPEN → ACTIVE → RECOVERED with correct duration; exactly
 *   one recovery per episode; recovery only when the condition is
 *   positively absent while its source was usable (never during a source
 *   outage — no false recoveries, no incident churn through outages).
 * - Cascade suppression (Fase 6): candidates whose required sources are
 *   unusable are WITHHELD; their impact is attributed to the ROOT source
 *   incident — never per-entity problems for dependent values.
 * - Debounce (Fase 14): derived conditions must persist before an
 *   incident opens; direct conditions open immediately.
 * - Flapping (Fase 11): repeated clear/reappear toggles inside the
 *   window hold ONE incident open with flapping=true — no push storm.
 * - Escalation (Fase 17): unhealthy escalates to critical after the
 *   sustained window, never on a blip.
 * - Baseline (Fase 33): first cycle after boot/upgrade ingests silently.
 */

export interface CycleInput {
  observation: IncidentObservation;
  state: IncidentsState;
}

export interface CycleOutput {
  active: Incident[];
  opened: Incident[];
  recoveredNow: Incident[];
  health: HealthSummary;
  confidence: ObservabilityConfidence;
  /** Raw events for the notification pipeline (all active, actionable). */
  events: RawEvent[];
}

const kindCategory: Record<string, EventCategory> = {
  "docker-unhealthy": "docker-health",
  "crash-loop": "docker-health",
  flapping: "docker-health",
  "update-failed": "docker-health",
  "array-state": "storage",
  "disk-state": "storage",
  "disk-thermal": "storage",
  thermal: "system-health",
  "memory-pressure": "system-health",
  "cpu-sustained": "system-health",
  "notification-backlog": "system-health",
  "source-unavailable": "services",
  "source-degraded": "services",
  "persistence-failure": "services",
};

function appendTimeline(incident: Incident, event: string, detail?: string | null, at?: number): void {
  incident.timeline.unshift({ at: new Date(at ?? Date.now()).toISOString(), event, detail: detail ?? null });
  if (incident.timeline.length > INCIDENT_TIMELINE_MAX) incident.timeline.length = INCIDENT_TIMELINE_MAX;
}

/** Underlying kind for a flapping fingerprint (revert after the flap). */
function kindForFingerprint(id: string): Incident["kind"] {
  if (id.endsWith(":unhealthy")) return "docker-unhealthy";
  if (id.endsWith(":crash-loop")) return "crash-loop";
  return "docker-unhealthy";
}

/** Detects restart events for crash-loop evidence and updates trackers.
 *  A restart event = observed restartCount delta OR a RUNNING→non-RUNNING
 *  transition. One event (a manual restart) can never satisfy the rule. */
function updateRestartTrackers(observation: IncidentObservation, state: IncidentsState): void {
  const windowStart = observation.now - CRASH_LOOP_WINDOW_MS;
  const byName = new Map(observation.docker?.containers.map((container) => [container.name, container]) ?? []);

  for (const [name, stamps] of Object.entries(state.restarts)) {
    if (!byName.has(name) && !observation.docker) {
      delete state.restarts[name]; // docker view gone entirely
      continue;
    }
    state.restarts[name] = stamps.filter((at) => at >= windowStart);
  }

  /* restartCount deltas (helper inventory LKG — additive evidence). */
  for (const container of observation.docker?.containers ?? []) {
    if (container.restartCount == null) continue;
    const previous = state.restartCounts[container.name];
    if (previous && container.restartCount > previous.count) {
      const stamps = state.restarts[container.name] ?? [];
      stamps.push(observation.now);
      state.restarts[container.name] = stamps.slice(-12);
    }
    state.restartCounts[container.name] = { count: container.restartCount, at: observation.now };
  }

  /* Observed RUNNING→non-RUNNING transitions (sampler evidence). */
  for (const transition of observation.transitions) {
    if (transition.from === "RUNNING" && transition.to !== "RUNNING" && byName.has(transition.name)) {
      const stamps = state.restarts[transition.name] ?? [];
      // A restartCount delta at the same moment is the same event.
      if (!stamps.some((at) => Math.abs(at - transition.at) < 5_000)) {
        stamps.push(transition.at);
        state.restarts[transition.name] = stamps.slice(-12);
      }
    }
  }
}

function blockedSourceFor(candidate: RuleCandidate, observation: IncidentObservation): string | null {
  for (const source of candidate.requiresUsable) {
    const health = observation.sources.find((entry) => entry.source === source);
    if (!health || health.status === "stale" || health.status === "unavailable") return source;
  }
  return null;
}

export function applyIncidentCycle(input: CycleInput): CycleOutput {
  const { observation, state } = input;
  const now = observation.now;
  const prevCycleAt = state.lastEvaluatedAt ? Date.parse(state.lastEvaluatedAt) : null;

  updateRestartTrackers(observation, state);

  const { candidates, undecidable } = evaluateRules(observation, { restarts: state.restarts, incidents: state.incidents });
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));

  /* Suppression pass (Fase 6): withhold blocked candidates, collect the
     impact lines for their ROOT source incident. */
  const withheld: Array<{ candidate: RuleCandidate; rootSource: string }> = [];
  const decidable: RuleCandidate[] = [];
  for (const candidate of candidates) {
    const blockedSource = blockedSourceFor(candidate, observation);
    if (blockedSource) withheld.push({ candidate, rootSource: blockedSource });
    else decidable.push(candidate);
  }
  const decidableIds = new Set(decidable.map((candidate) => candidate.id));

  const opened: Incident[] = [];
  const recoveredNow: Incident[] = [];
  const matchedIds = new Set<string>();

  /* 1. Update/open incidents from decidable candidates. */
  for (const candidate of decidable) {
    matchedIds.add(candidate.id);
    state.matchedAt[candidate.id] = now;
    const existing = state.incidents[candidate.id];

    if (!existing) {
      /* Debounce: derived conditions must persist before opening. The
         pending ANCHOR becomes firstSeenAt so duration is truthful. */
      if (candidate.debounceMs > 0) {
        const anchor = state.pending[candidate.id] ?? now;
        state.pending[candidate.id] = anchor;
        if (now - anchor < candidate.debounceMs) continue;
      }
      const anchor = state.pending[candidate.id];
      delete state.pending[candidate.id];
      const severity = candidate.severityOverride ?? SEVERITY_POLICY[candidate.kind];
      const incident: Incident = {
        id: candidate.id,
        entity: candidate.entity,
        kind: candidate.kind,
        title: candidate.title,
        severity,
        status: "active",
        firstSeenAt: new Date(anchor ?? now).toISOString(),
        lastSeenAt: new Date(now).toISOString(),
        durationMs: anchor != null ? now - anchor : 0,
        source: candidate.source,
        evidence: candidate.evidence.slice(0, INCIDENT_EVIDENCE_MAX),
        rootCauseId: null,
        impact: candidate.impact.slice(0, INCIDENT_IMPACT_MAX),
        notifiedAt: null,
        resolvedAt: null,
        flapping: false,
        actionable: candidate.actionable,
        timeline: [],
        safeCheck: candidate.safeCheck,
        delivery: null,
      };
      appendTimeline(incident, "incident opened", candidate.evidence[0]?.value ?? null, now);
      state.incidents[candidate.id] = incident;
      opened.push(incident);
      continue;
    }

    /* Existing incident: refresh the proof, keep identity + history. */
    const incident = existing;
    if (incident.flapping) {
      /* Condition returned during a flap hold — the ONE incident stays.
         presentSince tracks continuous presence to detect flap end. */
      if (!state.presentSince[candidate.id]) {
        state.presentSince[candidate.id] = now;
        appendTimeline(incident, "condition returned during flap hold", candidate.evidence[0]?.value ?? null, now);
      }
      incident.lastSeenAt = new Date(now).toISOString();
      incident.evidence = candidate.evidence.slice(0, INCIDENT_EVIDENCE_MAX);
      /* Flapped continuously present for a whole window → no longer
         flapping: revert to the underlying incident. */
      if (now - (state.presentSince[candidate.id] ?? now) >= FLAP_WINDOW_MS) {
        incident.flapping = false;
        incident.kind = kindForFingerprint(incident.id);
        incident.title = candidate.title;
        delete state.presentSince[candidate.id];
        appendTimeline(incident, "flap resolved — condition continuously present", null, now);
      }
      continue;
    }

    incident.status = "active";
    incident.resolvedAt = null;
    incident.lastSeenAt = new Date(now).toISOString();
    incident.durationMs = now - Date.parse(incident.firstSeenAt);
    incident.title = candidate.title;
    incident.impact = candidate.impact.slice(0, INCIDENT_IMPACT_MAX);
    incident.evidence = candidate.evidence.slice(0, INCIDENT_EVIDENCE_MAX);
    incident.safeCheck = candidate.safeCheck;
    incident.actionable = candidate.actionable;

    /* Escalation (Fase 17): LANGDURIG unhealthy → critical. */
    if (candidate.kind === "docker-unhealthy" && incident.severity === "warning") {
      const sustainedMs = now - Date.parse(incident.firstSeenAt);
      if (sustainedMs >= CONTAINER_UNHEALTHY_CRITICAL_AFTER_MS) {
        incident.severity = "critical";
        appendTimeline(incident, "escalated to critical", `unhealthy for ${Math.round(sustainedMs / 60_000)}m`, now);
      }
    }
  }

  /* 1b. Attribute withheld impact to the root source incident (Fase 6). */
  for (const { candidate, rootSource } of withheld) {
    const rootId =
      rootSource === "persistence"
        ? "beacon:persistence"
        : `source:${rootSource}:${observation.sources.find((entry) => entry.source === rootSource)?.status === "unavailable" ? "unavailable" : "degraded"}`;
    const root = state.incidents[rootId] ?? opened.find((incident) => incident.id === rootId);
    if (root) {
      for (const line of candidate.impactWhenSuppressed) {
        if (!root.impact.includes(line)) root.impact.push(line);
      }
      root.impact = root.impact.slice(0, INCIDENT_IMPACT_MAX);
    }
  }

  /* 2. Absent candidates: recovery, flap-holding, outage-holding. */
  for (const incident of Object.values(state.incidents)) {
    if (incident.status === "recovered") continue;
    const id = incident.id;
    if (matchedIds.has(id)) continue;

    const candidate = candidateById.get(id);

    if (candidate && !decidableIds.has(id)) {
      /* Condition present but withheld (source down): hold — unobservable
         is not recovered, and not re-alarmed. */
      continue;
    }
    if (!candidate && isUndecidable(id, undecidable)) {
      /* No data to decide (governing source down): hold. */
      continue;
    }

    /* The condition is positively absent this cycle. Record the clear
       transition only when it was present last cycle (a real toggle,
       not "still absent" — Fase 11 correctness). */
    const wasPresentLastCycle = prevCycleAt != null && (state.matchedAt[id] ?? 0) >= prevCycleAt - 1_000;
    if (wasPresentLastCycle) {
      const toggles = state.toggles[id] ?? [];
      toggles.push(now);
      state.toggles[id] = toggles.slice(-12);
    }
    const recentToggles = (state.toggles[id] ?? []).filter((at) => now - at <= FLAP_WINDOW_MS);
    const lastPresentAt = state.matchedAt[id] ?? Date.parse(incident.lastSeenAt);

    if (!incident.flapping && recentToggles.length >= FLAP_MIN_TRANSITIONS) {
      incident.flapping = true;
      incident.kind = "flapping";
      incident.title = `Flapping: ${incident.entity}`;
      incident.lastSeenAt = new Date(now).toISOString();
      incident.durationMs = now - Date.parse(incident.firstSeenAt);
      appendTimeline(incident, `condition cleared again (${recentToggles.length} toggles in window) — held open as FLAPPING`, null, now);
      continue;
    }

    if (incident.flapping) {
      /* Recover only after a stable healthy streak (Fase 11/13). */
      if (now - lastPresentAt < FLAP_RECOVERY_STABLE_MS) continue;
      appendTimeline(incident, "stable after flapping", null, now);
    }

    /* Real recovery (Fase 13): close once, duration exact. Toggle history
       SURVIVES recovery — cross-episode flap patterns must stay visible
       (a recovered-then-reopened incident within the window is a flap). */
    incident.status = "recovered";
    incident.resolvedAt = new Date(now).toISOString();
    incident.durationMs = Date.parse(incident.resolvedAt) - Date.parse(incident.firstSeenAt);
    incident.flapping = false;
    delete state.matchedAt[id];
    appendTimeline(incident, "recovered", null, now);
    recoveredNow.push(incident);
  }

  /* 3. Prune debounce anchors whose condition vanished pre-open. */
  for (const id of Object.keys(state.pending)) {
    if (!candidateById.has(id)) delete state.pending[id];
  }

  /* 4. First-cycle baseline: ingest silently (Fase 33 migration guard). */
  if (state.baselinedAt == null) {
    for (const incident of Object.values(state.incidents)) {
      if (incident.status === "active") incident.notifiedAt = incident.notifiedAt ?? new Date(now).toISOString();
    }
    state.baselinedAt = now;
  }

  const active = Object.values(state.incidents)
    .filter((incident) => incident.status === "active")
    .sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt),
    );

  state.lastEvaluatedAt = new Date(now).toISOString();

  return {
    active,
    opened,
    recoveredNow,
    health: deriveHealthFromIncidents(active),
    confidence: deriveConfidence(observation.sources, observation.prometheus.configured),
    events: active.filter((incident) => incident.actionable).map((incident) => incidentToRawEvent(incident, now)),
  };
}

function isUndecidable(fingerprint: string, undecidable: Array<{ fingerprintPrefix: string }>): boolean {
  return undecidable.some((entry) => fingerprint.startsWith(entry.fingerprintPrefix));
}

/** Overall verdict = pure function of active incidents (Fase 20). */
export function deriveHealthFromIncidents(active: Incident[]): HealthSummary {
  let level: HealthSummary["level"] = "healthy";
  const ranked: Array<{ rank: number; reason: string }> = [];
  for (const incident of active) {
    const incidentLevel = severityToHealthLevel(incident.severity);
    if (incidentLevel !== "healthy") {
      ranked.push({ rank: incidentLevel === "critical" ? 2 : 1, reason: incident.title });
    }
    if (incidentLevel === "critical") level = "critical";
    else if (incidentLevel === "attention" && level === "healthy") level = "attention";
  }
  return {
    level,
    reasons: ranked
      .sort((a, b) => b.rank - a.rank)
      .slice(0, 6)
      .map((entry) => entry.reason),
    counts: {
      critical: active.filter((incident) => incident.severity === "critical").length,
      warning: active.filter((incident) => incident.severity === "warning").length,
      info: active.filter((incident) => incident.severity === "info").length,
    },
  };
}

/** Health of health (Fase 24): is Beacon's own observability trusted?
 *  Pure over (sources, prometheusConfigured) so diagnostics can reuse it. */
export function deriveConfidence(
  sources: Array<{ source: string; status: string }>,
  prometheusConfigured: boolean,
): ObservabilityConfidence {
  const statusOf = (source: string) =>
    sources.find((entry) => entry.source === source)?.status ?? "healthy";
  const degraded = (source: string) => statusOf(source) !== "healthy";
  const reasons: string[] = [];

  if (degraded("unraid-api")) reasons.push("Server-state confidence degraded (Unraid API unhealthy)");
  if (prometheusConfigured && (degraded("prometheus") || degraded("cadvisor") || degraded("node-exporter"))) {
    reasons.push("Metrics confidence degraded");
  }
  if (degraded("helper") || degraded("docker-inventory")) reasons.push("Docker confidence degraded");
  if (degraded("persistence")) reasons.push("Incident/history durability degraded");

  const unraidDown = statusOf("unraid-api") === "unavailable";
  const promDown = prometheusConfigured && statusOf("prometheus") === "unavailable";
  return {
    level: unraidDown && promDown ? "blind" : reasons.length > 0 ? "degraded" : "full",
    reasons,
  };
}

/** Maps an active incident to the notification pipeline's RawEvent. */
export function incidentToRawEvent(incident: Incident, now: number): RawEvent {
  const primaryEvidence: Evidence | undefined = incident.evidence[0];
  const duration = formatDuration(now - Date.parse(incident.firstSeenAt));
  return {
    fingerprint: incident.id,
    category: kindCategory[incident.kind] ?? "system-health",
    severity: incident.severity as IncidentSeverity,
    title: incident.title,
    body: primaryEvidence ? `${primaryEvidence.value} · ${duration}` : `Active for ${duration}`,
    source: incident.source,
    url: `/incidents/${encodeURIComponent(incident.id)}`,
    occurredAt: now,
  };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Marks notification outcome on the incident (Fase 26/27 delivery
 *  observability — only technically proven facts). */
export function markIncidentNotified(
  state: IncidentsState,
  fingerprint: string,
  delivery: { push: string | null; inApp: string | null },
): void {
  const incident = state.incidents[fingerprint];
  if (!incident) return;
  incident.notifiedAt = new Date().toISOString();
  incident.delivery = { push: delivery.push, inApp: delivery.inApp, at: incident.notifiedAt };
  appendTimeline(
    incident,
    "notification sent",
    delivery.push === "provider-accepted"
      ? "push provider accepted"
      : delivery.inApp === "delivered"
        ? "delivered in-app"
        : null,
  );
}

export type { TimelineEvent };
