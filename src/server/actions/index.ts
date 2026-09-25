import { areActionsEnabled } from "@/server/env";
import { executeAction } from "./action-client";
import { recordAudit } from "./audit";
import { reserveAction, type PolicyDecision } from "./policy";
import type { ActionResponseBody } from "@/lib/api-types";

/**
 * Orchestrates one write action: capability check → policy guards →
 * execution → audit. The audit write happens for every attempt
 * (including rejections) so cooldown abuse is visible.
 */

export interface PerformActionInput {
  actor: string;
  sourceIp: string;
  kind: "docker" | "vm";
  action: string;
  targetId: string;
}

function policyRejection(decision: Extract<PolicyDecision, { allowed: false }>): ActionResponseBody {
  return {
    ok: false,
    status: "rejected",
    message: decision.reason,
  };
}

export async function performAction(input: PerformActionInput): Promise<ActionResponseBody> {
  const started = Date.now();

  if (!areActionsEnabled()) {
    return {
      ok: false,
      status: "rejected",
      message: "Write actions are disabled on this server.",
    };
  }

  const decision = reserveAction(input.actor, input.kind, input.targetId, input.action);
  if (!decision.allowed) {
    void recordAudit({
      actor: input.actor,
      sourceIp: input.sourceIp,
      kind: input.kind,
      action: input.action,
      targetName: "(target)",
      targetId: input.targetId,
      result: "rejected",
      durationMs: Date.now() - started,
      error: decision.reason,
    });
    return policyRejection(decision);
  }

  try {
    const outcome = await executeAction(input.kind, input.action, input.targetId);
    const auditTargetName = outcome.targetName ?? "(target)";
    void recordAudit({
      actor: input.actor,
      sourceIp: input.sourceIp,
      kind: input.kind,
      action: input.action,
      targetName: auditTargetName,
      targetId: input.targetId,
      result:
        outcome.status === "success"
          ? "success"
          : outcome.status === "not-found"
            ? "not-found"
            : outcome.status === "already-in-state"
              ? "already-in-state"
              : outcome.status === "timeout"
                ? "timeout"
                : "failed",
      durationMs: Date.now() - started,
      error: outcome.status === "success" ? undefined : outcome.message,
    });
    return {
      ok: outcome.status === "success" || outcome.status === "already-in-state",
      status:
        outcome.status === "success"
          ? "success"
          : outcome.status === "already-in-state"
            ? "already-in-state"
            : outcome.status === "not-found"
              ? "not-found"
              : outcome.status === "timeout"
                ? "timeout"
                : "error",
      message: outcome.message,
      state: outcome.postState,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    void recordAudit({
      actor: input.actor,
      sourceIp: input.sourceIp,
      kind: input.kind,
      action: input.action,
      targetName: "(target)",
      targetId: input.targetId,
      result: "failed",
      durationMs: Date.now() - started,
      error: message,
    });
    return { ok: false, status: "error", message };
  } finally {
    decision.release();
  }
}
