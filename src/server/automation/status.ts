import { access, constants } from "node:fs/promises";
import { getEnvSafe } from "@/server/env";
import { getHelperStatus } from "@/server/update/helper-client";
import { enrichedOverview } from "@/server/docker/updates";
import { containerStatsBatch } from "@/server/update/history";
import { evaluateTarget, POLICY_VERSION, type SchedulerContext, type TargetFacts } from "./policy";
import { automationTick, ensureScheduler, schedulerMeta } from "./scheduler";
import {
  digestAgeMs,
  loadQueue,
  loadState,
  readEvents,
  targetState,
  updateTarget,
  saveState,
  removeJobs,
  recordEvent,
  type QueuedJob,
} from "./store";
import { projectRegistryView, type ProjectRegistryView } from "./project-registry";

/**
 * Automation status (v0.8.0): everything the Automation UI and Operations
 * v2 need — policy verdicts for every container, the durable queue,
 * cooldowns/interventions, events, scheduler meta, and the project
 * registry summary. Also owns ensureScheduler() lifecycle.
 */

export interface AutomationStatus {
  policyVersion: string;
  enabled: boolean;
  paused: boolean;
  config: ReturnType<typeof loadConfigShape>;
  scheduler: { lastTickAt: string | null; intervalMs: number };
  window: { inWindow: boolean; reason: string };
  targets: Array<{
    name: string;
    state: string;
    reasons: string[];
    optIn: boolean;
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
    cooldownUntil: string | null;
    cooldownReason: string | null;
    interventionRequired: boolean;
    interventionReason: string | null;
    pipelineOwned: boolean;
  }>;
  queue: Array<Pick<QueuedJob, "id" | "target" | "scope" | "image" | "digest" | "reasons" | "state" | "createdAt" | "policyVersion">>;
  events: Awaited<ReturnType<typeof readEvents>>;
  projects: ProjectRegistryView;
  infrastructure: {
    helperHealthy: boolean | null;
    dataDirWritable: boolean;
    operationActive: boolean;
  };
}

type LoadedState = Awaited<ReturnType<typeof loadState>>;

function loadConfigShape(state: LoadedState) {
  return state.config;
}

export async function getAutomationStatus(): Promise<AutomationStatus> {
  ensureScheduler();
  const now = new Date();
  const [state, overview, helper] = await Promise.all([
    loadState(),
    enrichedOverview().catch(() => null),
    getHelperStatus().catch(() => null),
  ]);
  const queue = await loadQueue();
  const stats = await containerStatsBatch().catch(() => new Map());
  let writable = true;
  try {
    await access(getEnvSafe().AUDIT_DIR, constants.W_OK);
  } catch {
    writable = false;
  }

  const { isInMaintenanceWindow } = await import("./policy");
  const window = isInMaintenanceWindow(now, state.config);
  const context: SchedulerContext = {
    now,
    config: state.config,
    helperHealthy: helper?.reachable === true,
    dataDirWritable: writable,
    operationActive: helper?.lock !== null && helper?.lock !== undefined,
    windowOperationsUsed: state.windowOperationsUsed,
    registryDegraded: false,
    queuedCount: queue.length,
  };

  const targets: AutomationStatus["targets"] = [];
  if (overview?.available) {
    for (const container of overview.containers) {
      const target = targetState(state, container.name);
      const targetStats = stats.get(container.name) ?? { manualSuccesses: 0, rollbackCount: 0, lastSuccess: null, lastAttempt: null };
      const digestAge = await digestAgeMs(container.image, container.remote_digest, now);
      const facts: TargetFacts = {
        name: container.name,
        optIn: target.optIn,
        risk: container.risk,
        managementType: container.management_type,
        updateStrategy: container.update_strategy,
        healthcheckPresent: container.health !== null,
        snapshotPresent: container.rollback.snapshot_present,
        registryVerified: container.update_status === "UP_TO_DATE" || container.update_status === "UPDATE_AVAILABLE",
        updateAvailable: container.update_available,
        remoteDigest: container.remote_digest,
        digestAgeMs: digestAge,
        manualSuccesses: targetStats.manualSuccesses,
        rollbackCount: targetStats.rollbackCount,
        interventionRequired: target.interventionRequired,
        cooldownUntil: target.cooldownUntil,
        pipelineOwned: container.management_type === "pipeline_owned",
        externallyManaged: container.externallyManaged,
      };
      const verdict = evaluateTarget(facts, context);
      targets.push({
        name: container.name,
        state: verdict.state,
        reasons: verdict.reasons,
        optIn: target.optIn,
        risk: container.risk,
        managementType: container.management_type,
        healthcheckPresent: container.health !== null,
        snapshotPresent: container.rollback.snapshot_present,
        registryVerified: facts.registryVerified,
        updateAvailable: container.update_available,
        remoteDigest: container.remote_digest,
        digestAgeHours: digestAge === null ? null : Math.round((digestAge / 3_600_000) * 10) / 10,
        manualSuccesses: targetStats.manualSuccesses,
        rollbackCount: targetStats.rollbackCount,
        cooldownUntil: target.cooldownUntil,
        cooldownReason: target.cooldownReason,
        interventionRequired: target.interventionRequired,
        interventionReason: target.interventionReason,
        pipelineOwned: container.management_type === "pipeline_owned",
      });
    }
    targets.sort((a, b) => a.name.localeCompare(b.name));
  }

  return {
    policyVersion: POLICY_VERSION,
    enabled: state.config.enabled,
    paused: state.config.paused,
    config: state.config,
    scheduler: schedulerMeta(),
    window,
    targets,
    queue: queue.map((job) => ({
      id: job.id,
      target: job.target,
      scope: job.scope,
      image: job.image,
      digest: job.digest,
      reasons: job.reasons,
      state: job.state,
      createdAt: job.createdAt,
      policyVersion: job.policyVersion,
    })),
    events: await readEvents(30),
    projects: await projectRegistryView().catch(() => ({ projects: [], lastPollAt: null, stale: true })),
    infrastructure: {
      helperHealthy: helper?.reachable ?? null,
      dataDirWritable: writable,
      operationActive: helper?.lock != null,
    },
  };
}

/* ---- operator actions (route boundaries validate + audit) ---------------- */

export async function setConfig(patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  const { normalizeConfigPatch } = await import("./policy");
  const state = await loadState();
  const result = normalizeConfigPatch(patch as Parameters<typeof normalizeConfigPatch>[0], state.config);
  if (!result.ok) return result;
  const enabledChanged = result.config.enabled !== state.config.enabled;
  const pausedChanged = result.config.paused !== state.config.paused;
  await saveState({ ...state, config: result.config, policyVersion: POLICY_VERSION });
  if (enabledChanged) {
    // Disabling automation cancels pending jobs immediately (no new starts).
    if (!result.config.enabled) await cancelAllPending("automation disabled by operator");
  }
  if (pausedChanged && result.config.paused) {
    await cancelAllPending("automation paused by operator");
  }
  await recordEvent("config_changed", null, `automation config changed (enabled=${result.config.enabled}, paused=${result.config.paused})`);
  return { ok: true };
}

export async function setTargetOptIn(name: string, optIn: boolean): Promise<void> {
  await updateTarget(name, { optIn });
  if (!optIn) {
    // Opt-out cancels that target's pending auto job (no new job starts).
    await removeJobs((job) => job.target === name);
    await recordEvent("queue_cancelled", name, "queued auto job cancelled: opt-out");
  }
}

export async function acknowledgeTarget(name: string): Promise<void> {
  await updateTarget(name, {
    interventionRequired: false,
    interventionReason: null,
    cooldownUntil: null,
    cooldownReason: null,
  });
  await recordEvent("config_changed", name, "cooldown/intervention acknowledged by operator");
}

export async function cancelQueuedJob(id: string): Promise<boolean> {
  const jobs = await loadQueue();
  const job = jobs.find((entry) => entry.id === id);
  const removed = await removeJobs((entry) => entry.id === id);
  if (job && removed.length !== jobs.length) {
    await recordEvent("queue_cancelled", job.target, "queued auto job cancelled by operator");
    return true;
  }
  return false;
}

async function cancelAllPending(reason: string): Promise<number> {
  // Only QUEUED jobs are cancelled. In-flight (updating/verifying) jobs are
  // never dropped — their machine keeps running and settles normally with
  // full history/cooldown/intervention recording.
  const jobs = await loadQueue();
  const removed = await removeJobs((job) => job.state === "queued");
  for (const job of removed) {
    await recordEvent("queue_cancelled", job.target, `queued auto job cancelled: ${reason}`);
  }
  return jobs.length - removed.length;
}

export async function runOnce(): Promise<{ ranAt: string; summary: string; started?: string | null }> {
  return automationTick();
}
