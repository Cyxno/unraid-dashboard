import type { ManagedContainer } from "@/server/docker/model";
import { updateGate } from "@/server/docker/policy";

/**
 * Auto-update eligibility (v0.7.13): a pure verdict per container explaining
 * WHY it would or would not qualify for a future pilot-auto mode.
 *
 * v0.7.13 ships NO scheduler and NO automatic execution — broad auto-update
 * stays off. Eligibility exists so the operator can see which containers
 * are accumulating the track record a later opt-in would require.
 *
 * A container qualifies only when ALL of the following hold:
 *  - LOW risk, no database/auth/proxy/DNS role
 *  - a Docker healthcheck exists (objective verification signal)
 *  - >= 3 successful manual updates through this dashboard
 *  - zero rollbacks in its history
 *  - rollback proven: a pre-update snapshot exists
 *  - update gate allows it at all (not pipeline-owned/external/blocked)
 *  - the name is on the operator's pilot allowlist
 */

export interface AutoEligibilityInput {
  container: ManagedContainer;
  /** Successful manual updates through this dashboard. */
  manualSuccesses: number;
  /** Rollbacks (automatic or manual) for this container. */
  rollbackCount: number;
  /** Container names on the optional pilot allowlist. */
  pilotAllowlist: string[];
}

export interface AutoEligibility {
  eligible: boolean;
  reasons: string[];
}

export function computeAutoEligibility(input: AutoEligibilityInput): AutoEligibility {
  const { container } = input;
  const reasons: string[] = [];

  const gate = updateGate(container);
  if (!gate.canUpdate && container.update_available) {
    reasons.push(gate.blockedReason ?? "update gate refuses this container");
  }
  if (container.risk !== "LOW") {
    reasons.push(`risk is ${container.risk} — only LOW-risk containers qualify`);
  }
  if (container.management_type === "pipeline_owned" || container.externallyManaged) {
    reasons.push("externally managed — never auto-updated");
  }
  if (!container.health) {
    reasons.push("no Docker healthcheck — no objective verification signal");
  }
  if (input.manualSuccesses < 3) {
    reasons.push(`only ${input.manualSuccesses} successful manual update(s) — need 3+`);
  }
  if (input.rollbackCount > 0) {
    reasons.push(`${input.rollbackCount} rollback(s) on record — disqualifying`);
  }
  if (!container.rollback.snapshot_present) {
    reasons.push("no proven rollback snapshot yet");
  }
  const allowlisted = input.pilotAllowlist.includes(container.name);
  if (!allowlisted) {
    reasons.push("not on the pilot allowlist");
  }

  return { eligible: reasons.length === 0, reasons };
}

/** Pilot allowlist from operator env (comma-separated). Empty by default. */
export function pilotAllowlist(): string[] {
  const raw = process.env["PILOT_AUTO_CONTAINERS"] ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/**
 * Pilot auto-update master switch. v0.7.13 ships this DISABLED and nothing
 * in the codebase schedules or executes automatic updates; the flag exists
 * only so the eventual opt-in cannot silently widen beyond the allowlist.
 */
export function pilotAutoEnabled(): boolean {
  return process.env["PILOT_AUTO_ENABLED"] === "true" && pilotAllowlist().length > 0;
}
