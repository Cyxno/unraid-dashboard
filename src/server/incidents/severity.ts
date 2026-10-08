import type { IncidentKind, IncidentSeverity } from "@/lib/api-types";

/**
 * Central severity policy (v1.5.0 Fase 17). One table, auditable — no
 * rule invents its own severity. Deliberate v1.4.x → v1.5.0 changes:
 *
 * - Unread Unraid notification backlog: critical → INFO. A backlog is
 *   historical signal (often stale repeats of the same condition); live
 *   conditions get their own incidents from current state.
 * - Sustained thermal: attention/critical mix → WARNING (policy table).
 *   Hardware temperatures escalate through evidence, not fear: the
 *   incident carries temp, threshold, duration and correlated workload.
 * - Container unhealthy: starts WARNING, escalates to CRITICAL only
 *   after CONTAINER_UNHEALTHY_CRITICAL_AFTER_MS ("langdurig") — a single
 *   healthcheck blip must not page the household.
 * - Unchanged (already correct in v1.4.x): array/data integrity critical;
 *   stopped containers neutral; update availability INFO and never a
 *   health problem; update FAILURE warning.
 */

export const SEVERITY_POLICY: Record<IncidentKind, IncidentSeverity> = {
  "source-unavailable": "critical", // core observability source blind
  "source-degraded": "warning",
  "docker-unhealthy": "warning", // escalates to critical after sustained window
  "crash-loop": "warning",
  flapping: "warning",
  "array-state": "critical",
  "disk-state": "critical", // RED / fsColor / non-ok disk state = data risk
  "disk-thermal": "warning",
  thermal: "warning",
  "memory-pressure": "warning", // ≥95% escalates via rule to critical
  "cpu-sustained": "warning",
  "notification-backlog": "info",
  "update-failed": "warning",
  "persistence-failure": "critical", // incident/history durability at risk
};

/** Health level mapping for the derived overall verdict (Fase 20). */
export function severityToHealthLevel(severity: IncidentSeverity): "healthy" | "attention" | "critical" {
  if (severity === "critical") return "critical";
  if (severity === "warning") return "attention";
  return "healthy"; // info incidents never color the overall verdict
}

export const SEVERITY_RANK: Record<IncidentSeverity, number> = {
  critical: 2,
  warning: 1,
  info: 0,
};
