import { getOverview } from "@/server/unraid/service";
import { getDiagnostics } from "@/server/metrics-service";
import { enrichedOverview } from "@/server/docker/updates";
import { getAutomationStatus } from "@/server/automation/status";
import { listProjects } from "@/server/docker/project-service";
import { AGENT_API_VERSION } from "@/server/agent/auth";
import { dockerIssues, automationIssues, registryIssues, mergeObservations, type AgentIssue, type AutomationIssueFacts } from "@/server/agent/issues";
import { getBuildInfo } from "@/server/version";

/**
 * Agent API snapshot builders (v0.9.4): normalized, compact, read-only DTOs
 * assembled from data Beacon already collects (cached polls, scheduler
 * outputs). No new scans per request; freshness is explicit everywhere.
 *
 * Null + availability flags represent unavailable metrics — stale data is
 * never presented as live.
 */

export interface Freshness {
  sampledAt: string | null;
  stale: boolean;
  ageSeconds: number | null;
  source: string;
}

function freshness(sampledAt: string | null, stale: boolean, source: string): Freshness {
  return {
    sampledAt,
    stale,
    ageSeconds: sampledAt ? Math.max(0, Math.round((Date.now() - Date.parse(sampledAt)) / 1000)) : null,
    source,
  };
}

export interface AgentEnvelope<T> {
  apiVersion: string;
  beaconVersion: string;
  generatedAt: string;
  data: T;
}

export function envelope<T>(data: T): AgentEnvelope<T> {
  return {
    apiVersion: AGENT_API_VERSION,
    beaconVersion: getBuildInfo().version,
    generatedAt: new Date().toISOString(),
    data,
  };
}

/* ---- shared per-request data bundle (request-scoped, not cached) --------- */

export interface AgentDataBundle {
  overview: Awaited<ReturnType<typeof getOverview>> | null;
  diagnostics: Awaited<ReturnType<typeof getDiagnostics>> | null;
  updates: Awaited<ReturnType<typeof enrichedOverview>> | null;
  automation: Awaited<ReturnType<typeof getAutomationStatus>> | null;
  projects: Awaited<ReturnType<typeof listProjects>> | null;
  thermal: Awaited<ReturnType<typeof getThermalContext>> | null;
}

export async function loadBundle(): Promise<AgentDataBundle> {
  const [overview, diagnostics, updates, automation, projects, thermal] = await Promise.all([
    getOverview("15m").catch(() => null),
    getDiagnostics().catch(() => null),
    enrichedOverview().catch(() => null),
    getAutomationStatus().catch(() => null),
    listProjects().catch(() => null),
    getThermalContext().catch(() => null),
  ]);
  return { overview, diagnostics, updates, automation, projects, thermal };
}

/**
 * Read-only thermal context for the Agent API (v0.9.11): assembled from
 * the same cached analyses the UI uses — current, 24h/7d aggregates,
 * active-episode flag, recent episode count and the correlation summary
 * of the latest episode. No thresholds are duplicated here.
 */
export async function getThermalContext() {
  const { isPrometheusConfigured } = await import("@/server/prometheus/client");
  if (!isPrometheusConfigured()) return null;
  const { getThermalAnalysis, getThermal7dContext } = await import("@/server/prometheus/thermal");
  const { CPU_TEMP_WARNING_C, CPU_TEMP_CRITICAL_C } = await import("@/server/thresholds");
  const client = new (await import("@/server/prometheus/client")).PromClient();
  const [analysis, context7d] = await Promise.all([
    getThermalAnalysis(client, CPU_TEMP_WARNING_C, CPU_TEMP_CRITICAL_C).catch(() => null),
    getThermal7dContext(client, CPU_TEMP_WARNING_C, CPU_TEMP_CRITICAL_C).catch(() => null),
  ]);
  const latest = context7d?.recentEpisodes?.[0] ?? null;
  return {
    currentC: analysis?.currentC ?? null,
    avg24hC: analysis?.avg24hC ?? null,
    avg7dC: context7d?.avg7dC ?? null,
    prev7dAvgC: context7d?.prev7dAvgC ?? null,
    deltaC: context7d?.deltaC ?? null,
    state: analysis?.state ?? null,
    activeEpisode: latest?.ongoing === true,
    recentEpisodeCount7d: context7d?.episodes.aboveWarning ?? null,
    latestEpisode: latest
      ? {
          startMs: latest.startMs,
          endMs: latest.endMs,
          avgC: latest.avgC,
          maxC: latest.maxC,
          ongoing: latest.ongoing,
        }
      : null,
    dataQuality: context7d
      ? { coverageRatio: context7d.coverageRatio, samples: context7d.samples }
      : null,
  };
}

/* ---- summary -------------------------------------------------------------- */

import { areActionsEnabled } from "@/server/env";
import { DOCKER_ACTIONS } from "@/server/actions/action-client";

export interface AgentSummary {
  health: { level: string | null; reasons: string[] };
  cpu: { percent: number | null; load5: number | null };
  memory: { percent: number | null; usedBytes: number | null; totalBytes: number | null; availableBytes: number | null };
  storage: { state: string | null; usedBytes: number | null; totalBytes: number | null };
  docker: { running: number | null; total: number | null; unhealthy: number | null };
  vms: { total: number; running: number } | null;
  updatesAvailable: number | null;
  /** v0.9.11: read-only thermal context (no thresholds duplicated). */
  thermal: {
    currentC: number | null;
    avg24hC: number | null;
    avg7dC: number | null;
    prev7dAvgC: number | null;
    deltaC: number | null;
    state: string | null;
    activeEpisode: boolean;
    recentEpisodeCount7d: number | null;
    latestEpisode: { startMs: number; endMs: number | null; avgC: number; maxC: number; ongoing: boolean } | null;
    dataQuality: { coverageRatio: number; samples: number } | null;
  } | null;
  /** v0.9.10: read-only capability context (normalized model; the Agent
   *  API has NO action endpoints — this only describes what the UI can do). */
  actionCapabilities: {
    enabled: boolean;
    reason: string | null;
    docker: { start: boolean; stop: boolean; restart: false; pause: false; unpause: false };
  };
  automation: { enabled: boolean; paused: boolean; queueLength: number; eligible: number; cooldown: number; intervention: number } | null;
  dependencies: {
    unraid: boolean | null;
    prometheus: boolean | null;
    helper: boolean | null;
  };
  freshness: {
    overview: Freshness;
    updates: Freshness;
  };
}

export function buildSummary(bundle: AgentDataBundle): AgentSummary {
  const overviewData = bundle.overview;
  const docker = bundle.updates?.containers ?? [];
  const unhealthy = docker.filter((container) => container.health === "unhealthy").length;
  const updateCount = docker.filter((container) => container.update_available).length;
  return {
    health: {
      level: overviewData?.health.level ?? null,
      reasons: overviewData?.health.reasons ?? [],
    },
    cpu: {
      percent: overviewData?.cpu.data?.percentTotal ?? null,
      load5: bundle.overview?.extras?.load?.five ?? null,
    },
    memory: {
      percent: overviewData?.memory.data?.percentTotal ?? null,
      usedBytes: overviewData?.memory.data?.usedBytes ?? null,
      totalBytes: overviewData?.memory.data?.totalBytes ?? null,
      availableBytes: overviewData?.memory.data?.availableBytes ?? null,
    },
    storage: {
      state: overviewData?.storage.data?.state ?? null,
      usedBytes: overviewData?.storage.data?.usedBytes ?? null,
      totalBytes: overviewData?.storage.data?.totalBytes ?? null,
    },
    docker: {
      running: overviewData?.docker.data?.running ?? null,
      total: overviewData?.docker.data?.total ?? null,
      unhealthy,
    },
    vms: null,
    updatesAvailable: updateCount,
    thermal: bundle.thermal,
    actionCapabilities: (() => {
      const enabled = areActionsEnabled();
      const reason = enabled
        ? null
        : "Action key is not configured (UNRAID_ACTION_API_KEY missing).";
      return {
        enabled,
        reason,
        docker: {
          start: enabled && DOCKER_ACTIONS.includes("start"),
          stop: enabled && DOCKER_ACTIONS.includes("stop"),
          restart: false as const,
          pause: false as const,
          unpause: false as const,
        },
      };
    })(),
    automation: bundle.automation
      ? {
          enabled: bundle.automation.enabled,
          paused: bundle.automation.paused,
          queueLength: bundle.automation.queue.length,
          eligible: bundle.automation.targets.filter((target) => target.state === "eligible").length,
          cooldown: bundle.automation.targets.filter((target) => target.state === "cooldown").length,
          intervention: bundle.automation.targets.filter((target) => target.interventionRequired).length,
        }
      : null,
    dependencies: {
      unraid: bundle.diagnostics?.sources?.unraid?.reachable ?? null,
      prometheus: bundle.diagnostics?.sources?.prometheus?.reachable ?? null,
      helper: bundle.automation?.infrastructure.helperHealthy ?? null,
    },
    freshness: {
      overview: freshness(
        bundle.overview?.generatedAt ?? null,
        bundle.overview?.history?.status === "stale",
        "Unraid API",
      ),
      updates: freshness(
        bundle.updates?.checkedAt ?? null,
        bundle.updates?.checking === true,
        "Beacon derived (helper inventory + registry checks)",
      ),
    },
  };
}

/* ---- docker --------------------------------------------------------------- */

export function buildDockerList(bundle: AgentDataBundle): Array<Record<string, unknown>> {
  return (bundle.updates?.containers ?? []).map((container) => ({
    name: container.name,
    id: container.id,
    state: (container as unknown as { state?: string }).state ?? null,
    health: container.health,
    cpuPercent: (container as unknown as { metrics?: { cpuPercent?: number | null } }).metrics?.cpuPercent ?? null,
    memoryUsedBytes: (container as unknown as { metrics?: { memoryUsedBytes?: number | null } }).metrics?.memoryUsedBytes ?? null,
    image: container.image,
    updateAvailable: container.update_available,
    managementType: container.management_type,
    risk: container.risk,
    policy: container.policy,
    composeProject: (container as unknown as { composeProject?: string | null }).composeProject ?? null,
    provenance: container.provenance.state,
    restartSafe: ((container as unknown as { unsupported?: string[] }).unsupported ?? []).length === 0,
    freshness: freshness(bundle.updates?.checkedAt ?? null, bundle.updates?.checking === true, "Beacon derived"),
  }));
}

/* ---- issues --------------------------------------------------------------- */

export function buildIssues(
  bundle: AgentDataBundle,
  automationFacts: AutomationIssueFacts,
  registryVerified: boolean,
): AgentIssue[] {
  const containers = (bundle.updates?.containers ?? []).map((container) => ({
    name: container.name,
    id: container.id,
    health: container.health,
    updateAvailable: container.update_available,
    risk: container.risk,
    managementType: container.management_type,
    cpuPercent: (container as unknown as { metrics?: { cpuPercent?: number | null } }).metrics?.cpuPercent ?? null,
  }));
  const observations = [
    ...dockerIssues(containers),
    ...automationIssues(automationFacts, new Date()),
    ...registryIssues({ registryVerified }),
  ];
  return mergeObservations(new Date(), observations);
}
