import type {
  Incident,
  OperationRecord,
  RemediationAction,
  RemediationResult,
} from "@/lib/api-types";
import { currentIncidentSnapshot } from "@/server/incidents/cycle";
import { getPersistenceHealth, resetPersistenceCheckCache } from "@/server/incidents/persistence-check";
import { getOverview } from "@/server/unraid/service";
import { updatesOverview } from "@/server/docker/updates";
import { sendTestNotification } from "@/server/notifications";
import { areActionsEnabled } from "@/server/env";
import { findDockerTarget, EXPECTED_DOCKER_STATE } from "@/server/actions/action-client";
import { performAction } from "@/server/actions";
import { recordAudit } from "@/server/actions/audit";
import { recordRequestId, reserveAction, seenRequestId } from "@/server/actions/policy";
import { getHelperStatus, isUpdatePhaseActive, requestContainerUpdate } from "@/server/update/helper-client";
import { actionsForIncident } from "./runbooks";
import {
  beginOperation,
  conflictFor,
  ensureOperationsState,
  getOperationById,
  operationEvent,
  transitionOperation,
  DIAGNOSTIC_TIMEOUT_MS,
} from "./operations";
import {
  markActionConfirmed,
  markActionOutcome,
  markActionOffered,
  markObservedResult,
  markRequestAccepted,
  markVerificationOutcome,
} from "./incident-links";

/**
 * Remediation executor (v1.7.0 Fase 3/5/6/8/9/10/11/28).
 *
 * ONE entry point, a FIXED switch over RemediationActionType. Every
 * guarded action:
 *   1. re-checks preconditions on LIVE state just before executing
 *      (never acts on stale UI state);
 *   2. records an operation with the explicit lifecycle;
 *   3. treats HTTP success as "accepted", not "succeeded" — succeeded
 *      requires the effect to be OBSERVED;
 *   4. is idempotent per requestId, cooldown-bounded and conflict-checked.
 * Diagnostics never mutate system state beyond Beacon's own caches.
 */

export interface ExecuteInput {
  incidentId: string;
  actionId: string;
  actor: string;
  sourceIp: string;
  requestId?: string;
}

interface PreconditionResult {
  id: string;
  ok: boolean;
  detail: string;
}

const VERIFY_POLL_INTERVAL_MS = 2_000;
const VERIFY_POLL_ATTEMPTS = 6;

function incidentById(id: string): Incident | null {
  const snapshot = currentIncidentSnapshot();
  return (
    snapshot.active.find((incident) => incident.id === id) ??
    snapshot.recovered.find((incident) => incident.id === id) ??
    null
  );
}

function actionFromIncident(incident: Incident, actionId: string, actions: RemediationAction[]): RemediationAction | null {
  return actions.find((action) => action.id === actionId) ?? null;
}

/** Bounded independent re-read of the live Docker state (Fase 6/28). */
async function observeDockerState(
  name: string,
  expected: string,
): Promise<{ observed: string | null; ok: boolean; note: string }> {
  for (let attempt = 0; attempt < VERIFY_POLL_ATTEMPTS; attempt++) {
    const target = await findDockerTarget(name).catch(() => null);
    if (target) {
      if (target.state === expected) {
        return { observed: target.state, ok: true, note: `Docker reports ${expected} (verified via live inventory)` };
      }
      if (attempt === VERIFY_POLL_ATTEMPTS - 1) {
        return {
          observed: target.state,
          ok: false,
          note: `Live inventory reports '${target.state}' — expected '${expected}' after the action.`,
        };
      }
    } else if (attempt === VERIFY_POLL_ATTEMPTS - 1) {
      return { observed: null, ok: false, note: "Live inventory unreadable during verification — actual state unknown." };
    }
    await new Promise((resolve) => setTimeout(resolve, VERIFY_POLL_INTERVAL_MS));
  }
  return { observed: null, ok: false, note: "Verification window elapsed — actual state unknown." };
}

/** Preconditions re-checked against LIVE state (Fase 5). */
async function checkPreconditions(
  action: RemediationAction,
  incident: Incident,
): Promise<PreconditionResult[]> {
  const results: PreconditionResult[] = [];

  results.push({
    id: "incident-active",
    ok: incident.status === "active",
    detail: incident.status === "active" ? "incident still active" : "incident already recovered — acting on stale state is refused",
  });

  const conflict = conflictFor(incident.entity, action.type);
  results.push({
    id: "no-conflict",
    ok: conflict === null,
    detail: conflict ?? "no conflicting operation on this entity",
  });

  if (action.type === "docker-start" || action.type === "docker-stop") {
    results.push({
      id: "actions-enabled",
      ok: areActionsEnabled(),
      detail: areActionsEnabled() ? "write actions enabled" : "write actions are disabled on this server",
    });
    const target = await findDockerTarget(incident.entity).catch(() => null);
    results.push({
      id: "target-known",
      ok: target !== null && target.state.length > 0,
      detail: target ? `live inventory: '${target.name}' is ${target.state}` : "container not present in the live inventory",
    });
    if (action.type === "docker-stop" && target) {
      const crashLoopStale = incident.kind !== "crash-loop" && incident.status !== "active";
      results.push({ id: "stop-context", ok: !crashLoopStale, detail: "stop offered as crash-loop containment" });
    }
  }

  if (action.type === "verified-update-retry") {
    const helper = await getHelperStatus().catch(() => null);
    const helperHealthy = helper !== null && helper.configured && helper.reachable === true && !isUpdatePhaseActive(helper.phase);
    results.push({
      id: "helper-healthy",
      ok: helperHealthy,
      detail: helper ? (isUpdatePhaseActive(helper.phase) ? `helper busy in phase ${helper.phase}` : helper.reachable ? "helper healthy and idle" : "helper unreachable") : "helper not configured",
    });
  }

  return results;
}

async function auditRemediation(input: {
  actor: string;
  sourceIp: string;
  action: string;
  entity: string;
  result: "success" | "failed" | "rejected" | "not-found" | "already-in-state" | "timeout";
  durationMs: number;
  error?: unknown;
  incidentId?: string;
  operationId?: string;
  traceId?: string;
}): Promise<void> {
  await recordAudit({
    actor: input.actor,
    sourceIp: input.sourceIp,
    kind: "remediation",
    action: input.action,
    targetName: input.entity,
    targetId: input.entity,
    result: input.result,
    durationMs: input.durationMs,
    error: input.error,
    ...(input.incidentId ? { incidentId: input.incidentId } : {}),
    ...(input.operationId ? { operationId: input.operationId } : {}),
    ...(input.traceId ? { traceId: input.traceId } : {}),
  });
}

function reject(message: string, state: "rejected" | "blocked" = "rejected"): RemediationResult {
  return { ok: false, state, message, operation: null };
}

export async function executeRemediationAction(input: ExecuteInput): Promise<RemediationResult> {
  const started = Date.now();
  await ensureOperationsState();

  const incident = incidentById(input.incidentId);
  if (!incident) return reject("Incident not found.");

  const action = actionFromIncident(incident, input.actionId, actionsForIncident(incident));
  if (!action) return reject("This action is not offered for this incident.");
  if (action.risk === "manual-only") return reject("Manual-only guidance has no execute path by design.");

  // Idempotency (Fase 9): a repeated requestId returns the recorded
  // verdict instead of executing again.
  if (input.requestId) {
    const seen = seenRequestId(input.requestId, "remediation", action.type, incident.entity);
    if (seen) {
      const cached = seen.result as RemediationResult;
      return { ...cached, duplicate: true };
    }
  }

  markActionOffered(incident.id, action.title);

  // Cooldown + rate cap + mutual exclusion reuse the central policy (Fase 11).
  const policy = reserveAction(input.actor, "remediation", incident.entity, action.type);
  if (!policy.allowed) {
    void auditRemediation({
      actor: input.actor,
      sourceIp: input.sourceIp,
      action: action.type,
      entity: incident.entity,
      result: "rejected",
      durationMs: Date.now() - started,
      error: policy.reason,
      incidentId: incident.id,
    });
    return reject(policy.reason);
  }

  try {
    // Preconditions re-checked NOW, on live state (Fase 5).
    const preconditionResults = await checkPreconditions(action, incident);
    const failed = preconditionResults.filter((entry) => !entry.ok);
    if (failed.length > 0) {
      const message = `Preconditions not met: ${failed.map((entry) => entry.detail).join("; ")}`;
      void auditRemediation({
        actor: input.actor,
        sourceIp: input.sourceIp,
        action: action.type,
        entity: incident.entity,
        result: "rejected",
        durationMs: Date.now() - started,
        error: message,
        incidentId: incident.id,
      });
      return { ok: false, state: "blocked", message, operation: null, preconditionResults };
    }

    markActionConfirmed(incident.id, action.title, input.actor);

    const operation = beginOperation({
      entity: incident.entity,
      operation: action.type,
      incidentId: incident.id,
      actor: input.actor,
      timeoutMs: action.risk === "safe" ? DIAGNOSTIC_TIMEOUT_MS : undefined,
      traceId: `rem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    });
    markRequestAccepted(incident.id, operation.id);

    let result: RemediationResult;
    if (action.risk === "safe") {
      result = await runDiagnostic(action, incident, operation, input);
    } else {
      result = await runGuarded(action, incident, operation, input);
    }

    if (input.requestId) {
      recordRequestId(input.requestId, "remediation", action.type, incident.entity, result);
    }
    void auditRemediation({
      actor: input.actor,
      sourceIp: input.sourceIp,
      action: action.type,
      entity: incident.entity,
      result: result.ok ? "success" : "failed",
      durationMs: Date.now() - started,
      error: result.ok ? undefined : result.message,
      incidentId: incident.id,
      operationId: operation.id,
      traceId: operation.traceId ?? undefined,
    });
    return result;
  } finally {
    policy.release();
  }
}

/* ---------------------------- diagnostics -------------------------------- */

async function runDiagnostic(
  action: RemediationAction,
  incident: Incident,
  operation: OperationRecord,
  _input: ExecuteInput,
): Promise<RemediationResult> {
  transitionOperation(operation.id, "executing", "running read-only diagnostic");
  try {
    switch (action.type) {
      case "refresh-incident-evidence": {
        // Runs the incident cycle over the ALREADY-CACHED sections — no new
        // upstream polling (same cadence path the dashboard uses).
        await getOverview();
        const fresh = incidentById(incident.id);
        const latest = fresh?.evidence[0]?.observedAt ?? null;
        transitionOperation(operation.id, "verifying");
        transitionOperation(
          operation.id,
          "succeeded",
          latest ? `evidence refreshed (latest observation ${latest})` : "incident cycle re-run",
        );
        markVerificationOutcome(incident.id, `evidence refreshed (operation ${operation.id})`);
        return { ok: true, state: "succeeded", message: "Incident evidence refreshed.", operation: loadOperation(operation.id), detail: latest ?? undefined };
      }
      case "re-run-persistence-probe": {
        resetPersistenceCheckCache();
        const health = await getPersistenceHealth();
        transitionOperation(operation.id, "verifying");
        transitionOperation(
          operation.id,
          health.failing ? "failed" : "succeeded",
          health.failing ? (health.probeError ?? "data directory not writable") : `data directory writable (${health.dataDir})`,
        );
        markVerificationOutcome(incident.id, `persistence probe: ${health.failing ? "still failing" : "writable"}`);
        return {
          ok: !health.failing,
          state: health.failing ? "failed" : "succeeded",
          message: health.failing ? `Persistence still failing: ${health.probeError ?? "not writable"}` : "Persistence probe succeeded — data directory is writable.",
          operation: loadOperation(operation.id),
          detail: `${health.dataDir} writable=${String(health.dataDirWritable)} lastPersistAt=${health.lastPersistAt ?? "never"}`,
        };
      }
      case "re-check-registry": {
        const overview = await updatesOverview({ refresh: true });
        transitionOperation(operation.id, "verifying");
        transitionOperation(operation.id, "succeeded", `registry re-check completed for ${overview.containers.length} image(s)`);
        markVerificationOutcome(incident.id, "registry update state re-checked");
        return {
          ok: true,
          state: "succeeded",
          message: `Registry state re-checked for ${overview.containers.length} container image(s).`,
          operation: loadOperation(operation.id),
          detail: `checkedAt ${overview.checkedAt}`,
        };
      }
      case "re-probe-push-delivery": {
        const result = await sendTestNotification();
        const pushed = result.delivered === "pushed" || result.delivered === "in-app";
        transitionOperation(operation.id, "verifying");
        transitionOperation(operation.id, pushed ? "succeeded" : "failed", `delivery: ${result.delivered}`);
        markVerificationOutcome(incident.id, `push probe: ${result.delivered}`);
        return {
          ok: pushed,
          state: pushed ? "succeeded" : "failed",
          message: `Test notification delivery: ${result.delivered}. ${result.detail ?? ""}`.trim(),
          operation: loadOperation(operation.id),
          detail: result.detail ?? undefined,
        };
      }
      default:
        return reject("Unknown diagnostic action.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "diagnostic failed";
    transitionOperation(operation.id, "failed", message);
    markActionOutcome(incident.id, "failed", message);
    return { ok: false, state: "failed", message, operation: loadOperation(operation.id) };
  }
}

/* ------------------------------ guarded ---------------------------------- */

async function runGuarded(
  action: RemediationAction,
  incident: Incident,
  operation: OperationRecord,
  input: ExecuteInput,
): Promise<RemediationResult> {
  transitionOperation(operation.id, "executing", "executing confirmed action");
  try {
    switch (action.type) {
      case "docker-start":
      case "docker-stop": {
        const lifecycle = action.type === "docker-start" ? "start" : "stop";
        const target = await findDockerTarget(incident.entity).catch(() => null);
        if (!target) {
          transitionOperation(operation.id, "failed", "container vanished from live inventory");
          markActionOutcome(incident.id, "failed", "target not in live inventory");
          return { ok: false, state: "failed", message: "Container is not in the live inventory — refusing to act.", operation: loadOperation(operation.id) };
        }
        operationEvent(operation.id, "request accepted by Unraid action pipeline", `target ${target.id} state ${target.state}`);
        const outcome = await performAction({
          actor: input.actor,
          sourceIp: input.sourceIp,
          kind: "docker",
          action: lifecycle,
          targetId: target.id,
        });
        if (!outcome.ok && outcome.status !== "already-in-state") {
          transitionOperation(operation.id, outcome.status === "timeout" ? "timed-out" : "failed", outcome.message);
          markActionOutcome(incident.id, outcome.status === "timeout" ? "timed-out" : "failed", outcome.message);
          return { ok: false, state: outcome.status === "timeout" ? "timed-out" : "failed", message: outcome.message ?? "action failed", operation: loadOperation(operation.id) };
        }
        transitionOperation(operation.id, "verifying", "mutation accepted — observing actual effect");
        // EFFECT OBSERVED (Fase 6): independent live read, not the HTTP 200.
        const expected = EXPECTED_DOCKER_STATE[lifecycle];
        const observed = await observeDockerState(incident.entity, expected);
        markObservedResult(incident.id, observed.note, observed.ok);
        if (observed.ok) {
          transitionOperation(operation.id, "succeeded", observed.note);
          markVerificationOutcome(incident.id, `verified: container ${expected} in live inventory; incident re-evaluates on the next cycle`);
          markActionOutcome(incident.id, "recovered", observed.note);
          return { ok: true, state: "succeeded", message: observed.note, operation: loadOperation(operation.id) };
        }
        transitionOperation(operation.id, "failed", observed.note);
        markVerificationOutcome(incident.id, `not verified: ${observed.note}`);
        return { ok: false, state: "failed", message: observed.note, operation: loadOperation(operation.id) };
      }
      case "verified-update-retry": {
        const result = await requestContainerUpdate(incident.entity);
        if (!result.accepted) {
          const reason = result.reason ?? "update request refused";
          transitionOperation(operation.id, "failed", reason);
          markActionOutcome(incident.id, "failed", reason);
          return { ok: false, state: "failed", message: reason, operation: loadOperation(operation.id) };
        }
        operationEvent(operation.id, "helper accepted the update job", result.phase ?? undefined);
        // The update runs asynchronously in the helper's phase machine with
        // its own health verification and rollback. The operation stays
        // "verifying" and is reconciled by the helper job state — succeeded
        // only once the effect is observed.
        transitionOperation(operation.id, "verifying", "helper job accepted — verification follows the helper's own health checks");
        markVerificationOutcome(incident.id, "update job accepted; verification follows the helper phase machine");
        return {
          ok: true,
          state: "verifying",
          message: "Update job accepted. The helper verifies health, version and rollback readiness before this counts as succeeded.",
          operation: loadOperation(operation.id),
        };
      }
      default:
        return reject("Unknown guarded action.");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "guarded action failed";
    transitionOperation(operation.id, "failed", message);
    markActionOutcome(incident.id, "failed", message);
    return { ok: false, state: "failed", message, operation: loadOperation(operation.id) };
  }
}

function loadOperation(id: string): OperationRecord | null {
  return getOperationById(id);
}
