import { access, constants } from "node:fs/promises";
import { publishEvent } from "@/server/events/sampler";
import { getEnvSafe } from "@/server/env";
import { getHelperStatus, requestContainerUpdate, requestComposeUpdate, getContainerJob, type ContainerJob } from "@/server/update/helper-client";
import { enrichedOverview, type EnrichedOverview } from "@/server/docker/updates";
import { containerStatsBatch, recordContainerUpdate } from "@/server/update/history";
import { recordAudit } from "@/server/actions/audit";
import { evaluateTarget, isInMaintenanceWindow, POLICY_VERSION, type SchedulerContext, type TargetFacts } from "./policy";
import { saveState, type AutomationState as StoredAutomationState } from "./store";
import {
  ensureWindowCounter,
  enqueueJob,
  loadQueue,
  loadState,
  observeDigest,
  digestAgeMs,
  recordEvent,
  removeJobs,
  saveQueue,
  targetState,
  updateJob,
  updateTarget,
  type QueuedJob,
} from "./store";

/**
 * The pilot-auto scheduler/executor (v0.8.0).
 *
 * One shared tick (60s, unref'd, single-flight):
 *   1. observe remote digests (age-delay store)
 *   2. settle a running auto job if one exists (same machine as manual)
 *   3. otherwise re-validate queued jobs and start AT MOST one mutation
 *
 * The executor uses the SAME helper endpoints, preflight, digest
 * verification, rollback and health validation as manual updates — there
 * is no fast path. Defaults are conservative: global off, no opt-ins.
 */

const TICK_MS = 60_000;
const JOB_TIMEOUT_MS = 2 * 3_600_000;

const globalStore = globalThis as unknown as {
  __automationTickInFlight?: Promise<void> | null;
  __automationTimer?: ReturnType<typeof setInterval> | null;
  __automationLastTickAt?: string | null;
  /** Last evaluation snapshot: served by /api/automation without recompute. */
  __automationSnapshot?: { evaluatedAt: string; targets: TargetAutomationView[] } | null;
};

/**
 * Publishes the evaluation result for the status API. /api/automation NEVER
 * recomputes the heavy evaluation per request — it serves this snapshot and
 * (when stale) asks the scheduler for a fresh tick in the background.
 */
export function publishSnapshot(targets: TargetAutomationView[], evaluatedAt: string): void {
  globalStore.__automationSnapshot = { targets, evaluatedAt };
}

export function lastEvaluation(): { evaluatedAt: string | null; targets: TargetAutomationView[] } {
  return lastSnapshot();
}

export function lastSnapshot(): { evaluatedAt: string | null; targets: TargetAutomationView[] } {
  const snapshot = globalStore.__automationSnapshot;
  return { evaluatedAt: snapshot?.evaluatedAt ?? null, targets: snapshot?.targets ?? [] };
}

export function snapshotAgeMs(): number | null {
  const snapshot = globalStore.__automationSnapshot;
  return snapshot ? Date.now() - Date.parse(snapshot.evaluatedAt) : null;
}

export function requestRefresh(): void {
  if (globalStore.__automationTickInFlight) return;
  const run = automationTick()
    .then(() => undefined)
    .catch(() => undefined);
  globalStore.__automationTickInFlight = run;
  void run.finally(() => {
    globalStore.__automationTickInFlight = null;
  });
}

export interface TargetAutomationView {
  name: string;
  state: string;
  reasons: string[];
  facts: {
    risk: string;
    managementType: string;
    healthcheckPresent: boolean;
    snapshotPresent: boolean;
    registryVerified: boolean;
    updateAvailable: boolean;
    remoteDigest: string | null;
    digestAgeHours: number | null;
    manualSuccesses: number;
    rollbackCount: number;
    optIn: boolean;
    cooldownUntil: string | null;
    interventionRequired: boolean;
  };
}

/** Writable probe for /app/data — automation state must persist. */
async function dataDirWritable(): Promise<boolean> {
  try {
    await access(getEnvSafe().AUDIT_DIR, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Reads the remote-digest observation for every checked image. */
function digestObservations(overview: EnrichedOverview): Array<{ image: string; digest: string | null }> {
  return overview.containers
    .filter((container) => container.update_status === "UPDATE_AVAILABLE" || container.update_status === "UP_TO_DATE")
    .map((container) => ({ image: container.image, digest: container.remote_digest }));
}

async function gatherContext(state: StoredAutomationState, now: Date): Promise<SchedulerContext | null> {
  const helper = await getHelperStatus().catch(() => null);
  const helperHealthy = helper?.reachable === true;
  const writable = await dataDirWritable();
  return {
    now,
    config: state.config,
    helperHealthy,
    dataDirWritable: writable,
    operationActive: false, // set per-target below via helper lock
    windowOperationsUsed: state.windowOperationsUsed,
    registryDegraded: false, // per-target registryVerified covers this
    queuedCount: 0, // filled by caller
  };
}

/** Builds facts for one container from the overview + store + history. */
function factsFor(
  container: EnrichedOverview["containers"][number],
  stats: { manualSuccesses: number; rollbackCount: number },
  state: StoredAutomationState,
  digestAge: number | null,
): TargetFacts {
  const target = targetState(state, container.name);
  const registryVerified = container.update_status === "UP_TO_DATE" || container.update_status === "UPDATE_AVAILABLE";
  return {
    name: container.name,
    optIn: target.optIn,
    risk: container.risk,
    managementType: container.management_type,
    updateStrategy: container.update_strategy,
    healthcheckPresent: container.health !== null,
    snapshotPresent: container.rollback.snapshot_present,
    registryVerified,
    updateAvailable: container.update_available,
    remoteDigest: container.remote_digest,
    digestAgeMs: digestAge,
    manualSuccesses: stats.manualSuccesses,
    rollbackCount: stats.rollbackCount,
    interventionRequired: target.interventionRequired,
    cooldownUntil: target.cooldownUntil,
    pipelineOwned: container.management_type === "pipeline_owned",
    externallyManaged: container.externallyManaged,
  };
}

/** Settles a finished auto job: history, cooldown/intervention, events. */
async function settleJob(job: QueuedJob, helperJob: ContainerJob | null, startedAt: string): Promise<void> {
  const result = helperJob?.lastResult?.result ?? "stale-orphan";
  const rolledBack = result === "rolled-back" || result === "rollback-failed" || result === "stale-orphan";
  const success = result === "success" || result === "no-change";

  await recordContainerUpdate({
    startedAt,
    actor: "system:auto-update",
    target: job.target,
    scope: job.scope === "compose" ? "compose" : "container",
    adapter: job.scope === "compose" ? "compose" : "helper",
    image: job.image,
    digest: job.digest,
    durationMs: helperJob?.lastResult?.durationMs ?? 0,
    phasesReached: (helperJob?.phases ?? []).map((phase) => phase.phase),
    result: success ? "success" : rolledBack ? "rolled-back" : "failed",
    rollbackPerformed: result === "rolled-back",
    automation: {
      policyVersion: job.policyVersion,
      reasons: job.reasons,
      digest: job.digest,
      firstSeenAt: job.digestFirstSeenAt,
    },
    ...(helperJob?.lastResult?.error ? { error: helperJob.lastResult.error } : {}),
  }).catch(() => {});

  await recordAudit({
    actor: "system:auto-update",
    sourceIp: "scheduler",
    kind: "update",
    action: "auto-update",
    targetName: job.target,
    targetId: `${job.policyVersion};digest=${job.digest?.slice(0, 30) ?? "n/a"}`,
    result: success ? "success" : rolledBack ? "rejected" : "failed",
    durationMs: helperJob?.lastResult?.durationMs ?? 0,
    ...(helperJob?.lastResult?.error ? { error: helperJob.lastResult.error } : {}),
  }).catch(() => {});

  await removeJobs((entry) => entry.id === job.id);

  if (success) {
    await recordEvent("auto_update_completed", job.target, `auto-update completed (${result}) for ${job.target}`);
    return;
  }

  const state = await loadState();
  const cooldownUntil = new Date(Date.now() + state.config.cooldownHours * 3_600_000).toISOString();
  await updateTarget(job.target, {
    cooldownUntil,
    cooldownReason: `auto-update ${result}`,
    // A rollback that FAILED leaves the container in an unknown state —
    // manual intervention is mandatory before any future auto mutation.
    interventionRequired: result === "rollback-failed" || result === "stale-orphan",
    interventionReason: result === "rollback-failed" ? "rollback failed — verify container state manually" : null,
  });
  await recordEvent("cooldown_entered", job.target, `cooldown until ${cooldownUntil} after auto-update ${result} for ${job.target}`);
  if (result === "rolled-back") {
    await recordEvent("auto_update_rolled_back", job.target, `auto-update for ${job.target} was rolled back automatically`);
  }
  if (result === "rollback-failed" || result === "stale-orphan") {
    await recordEvent("intervention_required", job.target, `MANUAL INTERVENTION REQUIRED for ${job.target}: ${result}`);
  }
}

/** One scheduler tick. Returns a human summary (for status/run-once). */
export async function automationTick(): Promise<{ ranAt: string; summary: string; started?: string | null }> {
  const now = new Date();
  let state: StoredAutomationState = await loadState();
  state = await ensureWindowCounter(now, state.config);

  const overview = await enrichedOverview().catch(() => null);
  if (!overview?.available) {
    return { ranAt: now.toISOString(), summary: "inventory unavailable — tick skipped (no mutation, queue untouched)" };
  }
  // Registry hash poll runs inside the tick (TTL-gated) so the status API
  // only ever serves in-memory registry state.
  const { pollProjectRegistry } = await import("./project-registry");
  await pollProjectRegistry().catch(() => {});

  // /app/data unwritable → block EVERYTHING persistence-dependent (#33):
  // no observations, no queue changes, no mutations. State writes are also
  // bounded (5s) so a pathological filesystem can never hang the tick.
  if (!(await dataDirWritable())) {
    return { ranAt: now.toISOString(), summary: "/app/data not writable — tick skipped (auto updates blocked)" };
  }

  // 1. Observe remote digests for the age-delay store.
  for (const observation of digestObservations(overview)) {
    if (observation.digest) await observeDigest(observation.image, observation.digest, now);
  }

  const stats = await containerStatsBatch();
  const context = await gatherContext(state, now);
  if (!context) {
    return { ranAt: now.toISOString(), summary: "context unavailable — tick skipped" };
  }

  let queue = await loadQueue();

  // 2. Settle a running auto job (one mutation at a time).
  const running = queue.find((job) => job.state === "updating" || job.state === "verifying");
  if (running) {
    const helperJob = await getContainerJob(running.target).catch(() => null);
    const timedOut = Date.now() - Date.parse(running.createdAt) > JOB_TIMEOUT_MS;
    if (helperJob?.finishedAt) {
      await settleJob(running, helperJob, running.createdAt);
      return { ranAt: now.toISOString(), summary: `settled auto job for ${running.target}: ${helperJob.lastResult?.result ?? "?"}` };
    }
    if (timedOut) {
      await settleJob(running, null, running.createdAt);
      return { ranAt: now.toISOString(), summary: `auto job for ${running.target} timed out after 2h — cooldown + review` };
    }
    const phase = helperJob?.phase ?? "unknown";
    if (running.state === "updating" && (phase === "health-wait" || phase === "starting" || phase === "completed")) {
      await updateJob(running.id, { state: "verifying" });
    }
    return { ranAt: now.toISOString(), summary: `auto job for ${running.target} still running (phase ${phase})` };
  }

  // 3. Cancellation pass: policy changes kill PENDING jobs immediately.
  // In-flight (updating/verifying) jobs are NEVER dropped — their machine
  // keeps running and settles normally (history/cooldown/intervention).
  const cancellations: string[] = [];
  queue = await removeJobs((job) => {
    if (job.state !== "queued") return false;
    const target = targetState(state, job.target);
    const cancel =
      !state.config.enabled ||
      state.config.paused ||
      !target.optIn ||
      target.interventionRequired;
    if (cancel) cancellations.push(job.target);
    return cancel;
  });
  for (const target of cancellations) {
    await recordEvent("queue_cancelled", target, "queued auto job cancelled (policy/opt-out/intervention)");
  }

  // 4. Evaluation pass: compute the state for every opt-in container.
  const optInContainers = overview.containers.filter((container) => targetState(state, container.name).optIn);
  const evaluated: TargetAutomationView[] = [];
  let eligibleJob: { container: (typeof overview.containers)[number]; reasons: string[] } | null = null;
  for (const container of optInContainers) {
    const targetStats = stats.get(container.name) ?? { manualSuccesses: 0, rollbackCount: 0, lastSuccess: null, lastAttempt: null };
    const digestAge = await digestAgeMs(container.image, container.remote_digest, now);
    const facts = factsFor(container, targetStats, state, digestAge);
    const verdict = evaluateTarget(facts, context);
    evaluated.push({
      name: container.name,
      state: verdict.state,
      reasons: verdict.reasons,
      facts: {
        risk: facts.risk,
        managementType: facts.managementType,
        healthcheckPresent: facts.healthcheckPresent,
        snapshotPresent: facts.snapshotPresent,
        registryVerified: facts.registryVerified,
        updateAvailable: facts.updateAvailable,
        remoteDigest: facts.remoteDigest,
        digestAgeHours: digestAge === null ? null : Math.round((digestAge / 3_600_000) * 10) / 10,
        manualSuccesses: facts.manualSuccesses,
        rollbackCount: facts.rollbackCount,
        optIn: facts.optIn,
        cooldownUntil: facts.cooldownUntil,
        interventionRequired: facts.interventionRequired,
      },
    });
    if (verdict.state === "eligible" && container.remote_digest) {
      if (!queue.some((job) => job.target === container.name)) {
        await enqueueJob({
          target: container.name,
          scope: container.management_type === "compose" ? "compose" : "container",
          image: container.image,
          digest: container.remote_digest,
          digestFirstSeenAt: digestAge === null ? null : new Date(now.getTime() - digestAge).toISOString(),
          reasons: verdict.reasons,
        });
      }
      if (!eligibleJob && !queue.some((job) => job.target === container.name && job.state !== "queued")) {
        eligibleJob = { container, reasons: verdict.reasons };
      }
    }
  }

  queue = await loadQueue();
  const queuedView = queue.map((job) => ({
    id: job.id,
    target: job.target,
    scope: job.scope,
    image: job.image,
    digest: job.digest,
    reasons: job.reasons,
    state: job.state,
    createdAt: job.createdAt,
    policyVersion: job.policyVersion,
  }));

  // 5. Execution pass: start at most ONE mutation, inside the window.
  const window = evaluateWindow(now, state.config);
  const queuedJob = queue.find((job) => job.state === "queued");
  if (queuedJob && eligibleJob && window.inWindow && context.windowOperationsUsed < state.config.maxPerWindow) {
    const current = overview.containers.find((entry) => entry.name === queuedJob.target);
    const digestStillValid = current?.remote_digest !== null && current?.remote_digest === queuedJob.digest;
    if (!digestStillValid) {
      await removeJobs((entry) => entry.id === queuedJob.id);
      await recordEvent("queue_cancelled", queuedJob.target, "queued job cancelled: registry digest changed — eligibility recomputed on next tick");
      return { ranAt: now.toISOString(), summary: `queued job for ${queuedJob.target} cancelled (digest changed)` };
    }
    const helper = await getHelperStatus().catch(() => null);
    if (helper?.reachable === true && !helper.lock) {
      const dispatch = queuedJob.scope === "compose"
        ? await requestComposeUpdate(queuedJob.target)
        : await requestContainerUpdate(queuedJob.target);
      if (dispatch.accepted) {
        await updateJob(queuedJob.id, { state: "updating" });
        state = await loadState();
        state.windowOperationsUsed += 1;
        await saveState(state);
        await recordAudit({
          actor: "system:auto-update",
          sourceIp: "scheduler",
          kind: "update",
          action: "auto-update-dispatch",
          targetName: queuedJob.target,
          targetId: `${POLICY_VERSION};digest=${queuedJob.digest?.slice(0, 30) ?? "n/a"}`,
          result: "success",
          durationMs: 0,
        }).catch(() => {});
        return { ranAt: now.toISOString(), summary: `auto-update started for ${queuedJob.target}`, started: queuedJob.target };
      }
      await recordEvent("auto_update_blocked", queuedJob.target, `dispatch refused for ${queuedJob.target}: ${dispatch.reason ?? "unknown"}`);
      return { ranAt: now.toISOString(), summary: `dispatch refused for ${queuedJob.target}: ${dispatch.reason ?? "unknown"}` };
    }
    return { ranAt: now.toISOString(), summary: "helper busy or unavailable — queue held" };
  }

  const states = evaluated.map((entry) => `${entry.name}:${entry.state}`).join(", ") || "no opt-in targets";
  publishSnapshot(evaluated, now.toISOString());
  // Push a COMPACT status event over SSE (normalized, no inventory payload):
  // live Automation UI updates without waiting for its 15s poll fallback.
  publishEvent({
    event: "automation",
    data: {
    evaluatedAt: now.toISOString(),
    enabled: state.config.enabled,
    paused: state.config.paused,
    queueLength: queue.length,
    windowOpen: window.inWindow,
    eligible: evaluated.filter((entry) => entry.state === "eligible").length,
    cooldown: evaluated.filter((entry) => entry.state === "cooldown").length,
    intervention: evaluated.filter((entry) => entry.state === "intervention_required").length,
    targets: evaluated.map((entry) => ({ name: entry.name, state: entry.state, optIn: entry.facts.optIn })),
    },
  });
  return {
    ranAt: now.toISOString(),
    summary: `evaluated [${states}]; queued=${queuedView.length}; window=${window.inWindow ? "open" : "closed"}`,
  };
}

/** True when `now` falls inside the configured maintenance window. */
function evaluateWindow(now: Date, config: StoredAutomationState["config"]): { inWindow: boolean; reason: string } {
  return isInMaintenanceWindow(now, config);
}

/** Starts the background scheduler loop (idempotent). */
export function ensureScheduler(): void {
  if (globalStore.__automationTimer) return;
  globalStore.__automationLastTickAt = null;
  globalStore.__automationTimer = setInterval(() => {
    if (globalStore.__automationTickInFlight) return;
    globalStore.__automationTickInFlight = automationTick()
      .then((result) => {
        globalStore.__automationLastTickAt = result.ranAt;
      })
      .catch((error) => {
        console.error("[automation] tick failed:", error instanceof Error ? error.message : error);
      })
      .finally(() => {
        globalStore.__automationTickInFlight = null;
      });
  }, TICK_MS);
  globalStore.__automationTimer.unref?.();
}

export function schedulerMeta(): { lastTickAt: string | null; intervalMs: number } {
  return { lastTickAt: globalStore.__automationLastTickAt ?? null, intervalMs: TICK_MS };
}

/** Test hook: stop the loop and clear in-flight state. */
export function resetScheduler(): void {
  if (globalStore.__automationTimer) {
    clearInterval(globalStore.__automationTimer);
    globalStore.__automationTimer = null;
  }
  globalStore.__automationTickInFlight = null;
  globalStore.__automationLastTickAt = null;
}
