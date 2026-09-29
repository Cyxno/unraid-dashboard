import { access, constants } from "node:fs/promises";
import { getEnvSafe } from "@/server/env";
import { getHelperStatus } from "@/server/update/helper-client";
import { POLICY_VERSION, type AutomationConfig } from "./policy";
import { automationTick, ensureScheduler, lastEvaluation, requestRefresh, schedulerMeta, snapshotAgeMs, type TargetAutomationView } from "./scheduler";
import {
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
  config: AutomationConfig;
  scheduler: { lastTickAt: string | null; intervalMs: number; evaluating: boolean };
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

export async function getAutomationStatus(): Promise<AutomationStatus> {
  ensureScheduler();
  const now = new Date();
  const [state, helper] = await Promise.all([loadState(), getHelperStatus().catch(() => null)]);
  const queue = await loadQueue();
  let writable = true;
  try {
    await access(getEnvSafe().AUDIT_DIR, constants.W_OK);
  } catch {
    writable = false;
  }

  const { isInMaintenanceWindow } = await import("./policy");
  const window = isInMaintenanceWindow(now, state.config);

  // v0.9.2 latency fix: serve the scheduler's LAST evaluation — the request
  // path never recomputes the heavy sweep (65-container inventory + registry
  // hashes). When the snapshot is missing or stale, request a background
  // tick and surface "evaluating".
  const snapshot = lastEvaluation();
  const age = snapshotAgeMs();
  const evaluating = age === null || age > 90_000;
  if (evaluating) requestRefresh();

  const targets: AutomationStatus["targets"] = snapshot.targets
    .map((view) => {
      const target = targetState(state, view.name);
      return {
        name: view.name,
        state: view.state,
        reasons: view.reasons,
        optIn: target.optIn,
        risk: view.facts.risk,
        managementType: view.facts.managementType,
        healthcheckPresent: view.facts.healthcheckPresent,
        snapshotPresent: view.facts.snapshotPresent,
        registryVerified: view.facts.registryVerified,
        updateAvailable: view.facts.updateAvailable,
        remoteDigest: view.facts.remoteDigest,
        digestAgeHours: view.facts.digestAgeHours,
        manualSuccesses: view.facts.manualSuccesses,
        rollbackCount: view.facts.rollbackCount,
        cooldownUntil: view.facts.cooldownUntil,
        cooldownReason: target.cooldownReason,
        interventionRequired: target.interventionRequired,
        interventionReason: target.interventionReason,
        pipelineOwned: view.facts.managementType === "pipeline_owned",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    policyVersion: POLICY_VERSION,
    enabled: state.config.enabled,
    paused: state.config.paused,
    config: state.config,
    scheduler: { ...schedulerMeta(), evaluating },
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
    projects: await serveRegistryView(),
    infrastructure: {
      helperHealthy: helper?.reachable ?? null,
      dataDirWritable: writable,
      operationActive: helper?.lock != null,
    },
  };
}

/** Registry view from memory; expired polls are kicked to the background. */
async function serveRegistryView(): Promise<ProjectRegistryView> {
  const registryModule = await import("./project-registry");
  const registry = await registryModule.loadRegistry();
  const expired = !registry.lastPollAt || Date.now() - Date.parse(registry.lastPollAt) > 15 * 60_000;
  if (expired) {
    const { pollProjectRegistry } = await import("./project-registry");
    void pollProjectRegistry().catch(() => {});
  }
  return projectRegistryView();
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
