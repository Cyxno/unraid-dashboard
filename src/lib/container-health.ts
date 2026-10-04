import type { ContainerHealth } from "@/lib/api-types";

/**
 * Canonical Docker container health classification (v1.3.8).
 *
 * One shared model for every consumer — Docker list, Problems filter,
 * problem counters, Overview, NOC, notifications, agent issues, mobile —
 * so a stopped container can never be a problem on one screen and an
 * incident on another.
 *
 * Core rule (v1.3.8): STATE != HEALTH ISSUE. A deliberately stopped,
 * exited or paused container is an operational state, not a failure.
 * Users legitimately keep rarely-used containers off; autostart=true and
 * a leftover non-zero exit code prove nothing on their own (the inventory
 * does not even carry exit codes, so stale ones cannot leak in).
 *
 * Only actionable failure evidence is a problem:
 *   - Docker healthcheck reports unhealthy
 *   - container is restarting / crash-looping (Docker status evidence)
 *   - update machine reports a failed update (existing update semantics)
 *   - concrete container error (failed start, gone, etc.)
 */

export type ContainerState = "RUNNING" | "PAUSED" | "EXITED";

export interface ContainerHealthInput {
  state: ContainerState;
  health: ContainerHealth;
  /** Docker status string, e.g. "Restarting (1) 5 seconds ago". */
  status?: string | null;
  /** Set by the update machine when an update failed for this container. */
  updateFailed?: boolean;
  /** Set when concrete start-failure evidence exists for this container. */
  startError?: boolean;
}

export type ContainerHealthClass =
  | "healthy"
  | "running"
  | "stopped"
  | "paused"
  | "restarting"
  | "unhealthy"
  | "error";

export interface ContainerHealthVerdict {
  /** Coarse class for badges/labels. */
  classification: ContainerHealthClass;
  /** True only for actionable failures — never for a deliberate stop. */
  isProblem: boolean;
}

/** Docker status strings for restarting containers, e.g.
 *  "Restarting (1) 23 seconds ago". The inventory maps a restarting
 *  container to state RUNNING (Docker reports it as such), so the status
 *  string is the only reliable evidence. */
const RESTARTING_STATUS = /\brestarting\b/i;

export function classifyContainerHealth(
  container: ContainerHealthInput,
): ContainerHealthVerdict {
  if (container.startError) {
    return { classification: "error", isProblem: true };
  }
  if (container.updateFailed) {
    return { classification: "error", isProblem: true };
  }
  if (container.state === "EXITED") {
    // Deliberate stop / one-shot utility / rarely used tool. Informative,
    // never a problem — regardless of autostart or old exit codes.
    return { classification: "stopped", isProblem: false };
  }
  if (container.state === "PAUSED") {
    // Paused is operator intent too: informative, not an incident.
    return { classification: "paused", isProblem: false };
  }
  // state === "RUNNING" from here.
  if (container.health === "unhealthy") {
    return { classification: "unhealthy", isProblem: true };
  }
  if (container.status && RESTARTING_STATUS.test(container.status)) {
    // Restarting / crash-loop evidence from the Docker status string.
    return { classification: "restarting", isProblem: true };
  }
  if (container.health === "healthy") {
    return { classification: "healthy", isProblem: false };
  }
  // health null (no HEALTHCHECK) or "starting" (transitional): running,
  // not a problem — absence of a healthcheck is not unhealthy.
  return { classification: "running", isProblem: false };
}

/** Convenience predicate for Problems filters and counters. */
export function isContainerProblem(
  container: ContainerHealthInput,
): boolean {
  return classifyContainerHealth(container).isProblem;
}
