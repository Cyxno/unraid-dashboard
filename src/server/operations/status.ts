import { access, constants } from "node:fs/promises";
import { getEnvSafe } from "@/server/env";
import { getDiagnostics } from "@/server/metrics-service";
import type { DiagnosticsPayload } from "@/lib/api-types";
import { getHelperStatus, isUpdatePhaseActive } from "@/server/update/helper-client";
import { checkForUpdate } from "@/server/actions/update-check";
import { readUpdateHistory, readContainerHistory, type UpdateHistoryEntry } from "@/server/update/history";
import { listBackups } from "@/server/resilience/backup";
import { getBuildInfo } from "@/server/version";
import { pilotAutoEnabled } from "@/server/update/eligibility";
import { buildReleaseChain, readBootMarker, type ReleaseChain } from "@/server/update/release-chain";
import { enrichedOverview } from "@/server/docker/updates";
import { getAutomationStatus } from "@/server/automation/status";

/**
 * Operations status (v0.7.13): the aggregate behind the read-only
 * Operations page — the operator's "what is broken?" view. Composes
 * existing probes (diagnostics, helper status, resilience, history);
 * introduces no new host access and exposes no secrets.
 */

export interface OperationsStatus {
  generatedAt: string;
  app: {
    healthy: boolean;
    version: string;
    gitSha: string | null;
    buildTime: string | null;
    authMode: string;
    dataDirWritable: boolean | null;
    dataVolumeFreeBytes: number | null;
  };
  dependencies: {
    unraid: { reachable: boolean | null; latencyMs: number | null };
    prometheus: { reachable: boolean; latencyMs: number | null; configured: boolean };
    helper: { reachable: boolean | null; configured: boolean; version: string | null; reason: string | null };
  };
  ghcr: {
    /** GHCR auth verdict for private pulls: what the update path needs. */
    state: "ok" | "auth_required" | "unknown";
    message: string | null;
    tokenConfigured: boolean;
    registryAuthorized: boolean | null;
    latestTag: string | null;
    latestManifestDigest: string | null;
    status: string | null;
    reason: string | null;
  };
  persistence: {
    backupsPresent: number;
    latestBackup: { file: string; createdAt: string; bytes: number } | null;
  };
  updates: {
    latestSuccessful: { toVersion: string; at: string; usedLocalImage: boolean; scope: string; target: string | null } | null;
    latestRollback: { scope: string; target: string | null; at: string } | null;
    rollbackImage: { tag: string | null; imageId: string | null; currentVersion: string | null; localVersions: string[] };
    pilotAutoEnabled: boolean;
  };
  /** v0.7.14: tag → CI → GHCR → credential → remote pull → running digest. */
  releaseChain: ReleaseChain;
  /** v0.8.0: automation + compose registry summaries. */
  automation: {
    enabled: boolean;
    paused: boolean;
    policyVersion: string;
    lastTickAt: string | null;
    windowOpen: boolean;
    windowReason: string;
    eligibleCount: number;
    queuedCount: number;
    cooldownCount: number;
    interventionCount: number;
    optInCount: number;
  };
  projects: {
    count: number;
    changedConfigs: number;
    pipelineOwned: number;
    lastPollAt: string | null;
    stale: boolean;
  };
  operations: {
    active: { kind: string; target: string | null; phase: string; startedAt: string | null; stale: boolean } | null;
    staleCandidates: Array<{ job: string; phase: string; startedAt: string | null }>;
  };
}

const ACTIVE_PHASES = new Set([
  "requested", "snapshotting", "pulling", "verifying", "recreating", "starting", "health-wait",
]);

function isStale(startedAt: string | null): boolean {
  if (!startedAt) return false;
  return Date.now() - Date.parse(startedAt) > 30 * 60_000;
}

function latestRollbackOf(self: UpdateHistoryEntry[], containers: UpdateHistoryEntry[]): { scope: string; target: string | null; at: string } | null {
  const rolled = containers.find((entry) => entry.rollbackPerformed);
  if (rolled) return { scope: rolled.scope ?? "container", target: rolled.target ?? null, at: rolled.timestamp };
  const selfRolled = self.find((entry) => entry.rollbackPerformed);
  if (selfRolled) return { scope: "self", target: null, at: selfRolled.timestamp };
  return null;
}

export async function getOperationsStatus(): Promise<OperationsStatus> {
  const generatedAt = new Date().toISOString();
  const [diagnostics, helper, backups, history, containerHistory, release, enriched, bootMarker, automation, projects] = await Promise.all([
    getDiagnostics().catch(() => null as DiagnosticsPayload | null),
    getHelperStatus().catch(() => null),
    listBackups().catch(() => []),
    readUpdateHistory().catch(() => [] as UpdateHistoryEntry[]),
    readContainerHistory().catch(() => [] as UpdateHistoryEntry[]),
    checkForUpdate().catch(() => null),
    enrichedOverview().catch(() => null),
    readBootMarker().catch(() => null),
    getAutomationStatus().catch(() => null),
    (await import("@/server/automation/project-registry")).projectRegistryView().catch(() => null),
  ]);
  const env = getEnvSafe();
  const build = getBuildInfo();

  let dataDirWritable: boolean | null = null;
  try {
    await access(env.AUDIT_DIR, constants.W_OK);
    dataDirWritable = true;
  } catch {
    dataDirWritable = false;
  }

  const latestBackup = backups[0] ?? null;
  const latestSuccessfulAll = [...containerHistory, ...history].find((entry) => entry.result === "success") ?? null;

  // GHCR verdict: the helper's hourly probe is the pull-truth source;
  // the app-side registry check explains the update-check path.
  let ghcrState: OperationsStatus["ghcr"]["state"] = "unknown";
  let ghcrMessage: string | null = null;
  if (helper?.reachable && helper.pullAuthRequired === true) {
    ghcrState = "auth_required";
    ghcrMessage = "GHCR login required — the helper's pull probe was rejected (run scripts/login-ghcr.sh on the host).";
  } else if (helper?.reachable && helper.pullAvailable === true) {
    ghcrState = "ok";
    ghcrMessage = null;
  } else if (!helper?.reachable) {
    ghcrState = "unknown";
    ghcrMessage = helper?.configured ? "Helper unreachable — GHCR pull state unknown." : "Helper not configured — GHCR pull state unknown.";
  }
  if (release && !release.registry.tokenConfigured && ghcrState === "unknown") {
    ghcrState = "auth_required";
    ghcrMessage = "GHCR login required — no read token configured for registry checks (run scripts/login-ghcr.sh on the host).";
  }

  // Active operation: prefer the self-update machine phase, fall back to
  // container/project jobs; a held lock is surfaced as active too.
  let active: OperationsStatus["operations"]["active"] = null;
  if (helper?.reachable && helper.phase && isUpdatePhaseActive(helper.phase)) {
    active = { kind: "self-update", target: null, phase: helper.phase, startedAt: helper.startedAt, stale: isStale(helper.startedAt) };
  } else if (helper?.reachable && helper.lock) {
    active = { kind: "deployment-lock", target: null, phase: helper.phase ?? "locked", startedAt: helper.lock.since, stale: isStale(helper.lock.since) };
  }
  const staleCandidates: OperationsStatus["operations"]["staleCandidates"] = [];
  if (helper?.reachable && env.UPDATE_HELPER_URL) {
    try {
      const response = await fetch(`${env.UPDATE_HELPER_URL}/container-job`, {
        headers: { authorization: `Bearer ${env.UPDATE_HELPER_TOKEN ?? ""}` },
        signal: AbortSignal.timeout(5_000),
        cache: "no-store",
      });
      if (response.ok) {
        const body = (await response.json()) as { jobs?: Record<string, { phase?: string; startedAt?: string; finishedAt?: string | null }> };
        for (const [job, info] of Object.entries(body.jobs ?? {})) {
          if (info.finishedAt) continue;
          if (info.phase && ACTIVE_PHASES.has(info.phase) && isStale(info.startedAt ?? null)) {
            staleCandidates.push({ job, phase: info.phase, startedAt: info.startedAt ?? null });
          }
        }
      }
    } catch {
      // helper busy/unreachable — the stale scan is best-effort
    }
  }
  if (!active && staleCandidates.length > 0) {
    const first = staleCandidates[0]!;
    active = { kind: "container-job", target: first.job, phase: first.phase, startedAt: first.startedAt, stale: true };
  }

  return {
    generatedAt,
    app: {
      healthy: true,
      version: build.version,
      gitSha: build.gitSha ?? null,
      buildTime: build.buildTime ?? null,
      authMode: env.AUTH_MODE,
      dataDirWritable,
      dataVolumeFreeBytes: diagnostics?.self?.dataVolumeFreeBytes ?? null,
    },
    dependencies: {
      unraid: {
        reachable: diagnostics?.sources?.unraid?.reachable ?? null,
        latencyMs: diagnostics?.sources?.unraid?.latencyMs ?? null,
      },
      prometheus: {
        reachable: diagnostics?.sources?.prometheus?.reachable ?? false,
        latencyMs: diagnostics?.sources?.prometheus?.latencyMs ?? null,
        configured: diagnostics?.sources?.prometheus?.configured ?? false,
      },
      helper: {
        reachable: helper?.reachable ?? null,
        configured: helper?.configured ?? false,
        version: helper?.helperVersion ?? null,
        reason: helper?.reason ?? null,
      },
    },
    ghcr: {
      state: ghcrState,
      message: ghcrMessage,
      tokenConfigured: release?.registry.tokenConfigured ?? false,
      registryAuthorized: release?.registry.authorized ?? null,
      latestTag: release?.latestTag ?? null,
      latestManifestDigest: diagnostics?.self?.ghcrDigest ?? null,
      status: release?.status ?? null,
      reason: release?.registry.reason ?? null,
    },
    persistence: {
      backupsPresent: backups.length,
      latestBackup: latestBackup ? { file: latestBackup.file, createdAt: latestBackup.createdAt, bytes: latestBackup.bytes } : null,
    },
    updates: {
      latestSuccessful: latestSuccessfulAll
        ? {
            toVersion: latestSuccessfulAll.toVersion,
            at: latestSuccessfulAll.timestamp,
            usedLocalImage: latestSuccessfulAll.usedLocalImage,
            scope: latestSuccessfulAll.scope ?? "self",
            target: latestSuccessfulAll.target ?? null,
          }
        : null,
      latestRollback: latestRollbackOf(history, containerHistory),
      rollbackImage: {
        tag: "previous",
        imageId: helper?.currentImageId ?? null,
        currentVersion: helper?.currentVersion ?? null,
        localVersions: helper?.localVersions ?? [],
      },
      pilotAutoEnabled: pilotAutoEnabled(),
    },
    releaseChain: buildReleaseChain({
      helper,
      appContainer: enriched?.containers.find((entry) => entry.name === "unraid-dashboard") ?? null,
      history,
      bootMarker,
    }),
    automation: {
      enabled: automation?.enabled ?? false,
      paused: automation?.paused ?? false,
      policyVersion: automation?.policyVersion ?? "unknown",
      lastTickAt: automation?.scheduler.lastTickAt ?? null,
      windowOpen: automation?.window.inWindow ?? false,
      windowReason: automation?.window.reason ?? "unknown",
      eligibleCount: automation?.targets.filter((target) => target.state === "eligible").length ?? 0,
      queuedCount: automation?.queue.length ?? 0,
      cooldownCount: automation?.targets.filter((target) => target.state === "cooldown").length ?? 0,
      interventionCount: automation?.targets.filter((target) => target.interventionRequired).length ?? 0,
      optInCount: automation?.targets.filter((target) => target.optIn).length ?? 0,
    },
    projects: {
      count: projects?.projects.length ?? 0,
      changedConfigs: projects?.projects.filter((entry) => entry.configChanged).length ?? 0,
      pipelineOwned: projects?.projects.filter((entry) => entry.summary?.pipelineOwned).length ?? 0,
      lastPollAt: projects?.lastPollAt ?? null,
      stale: projects?.stale ?? true,
    },
    operations: { active, staleCandidates },
  };
}
