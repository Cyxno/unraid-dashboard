import type { TimelineEvent } from "@/lib/api-types";
import { loadIncidentsState, scheduleIncidentsSave } from "@/server/incidents/store";

/**
 * Bridges remediation operations into the incident timeline (v1.7.0
 * Fase 7). Events are factual and secret-free: action offered, user
 * confirmed, request accepted, observed result, verification outcome,
 * recovery or failure.
 */

export function recordIncidentActionEvent(incidentId: string | null, event: string, detail?: string | null): void {
  if (!incidentId) return;
  const state = loadIncidentsState();
  const incident = state.incidents[incidentId];
  if (!incident) return;
  incident.timeline.unshift({ at: new Date().toISOString(), event, detail: detail ?? null });
  if (incident.timeline.length > 30) incident.timeline.length = 30;
  scheduleIncidentsSave();
}

/** Marks an incident as action-offered so the UI can show the context. */
export function markActionOffered(incidentId: string | null, actionTitle: string): void {
  recordIncidentActionEvent(incidentId, `action offered: ${actionTitle}`, null);
}

export function markActionConfirmed(incidentId: string | null, actionTitle: string, actor: string): void {
  recordIncidentActionEvent(incidentId, `user confirmed: ${actionTitle}`, `actor ${actor}`);
}

export function markRequestAccepted(incidentId: string | null, operationId: string): void {
  recordIncidentActionEvent(incidentId, "request accepted", `operation ${operationId}`);
}

export function markObservedResult(
  incidentId: string | null,
  observed: string,
  verified: boolean,
): void {
  recordIncidentActionEvent(
    incidentId,
    verified ? "observed result: expected state" : "observed result: state differs from expectation",
    observed,
  );
}

export function markVerificationOutcome(incidentId: string | null, outcome: string): void {
  recordIncidentActionEvent(incidentId, "verification", outcome);
}

export function markActionOutcome(incidentId: string | null, outcome: "recovered" | "failed" | "timed-out", detail?: string): void {
  recordIncidentActionEvent(incidentId, `action ${outcome}`, detail ?? null);
}

export type { TimelineEvent };
