import { getEnvSafe } from "@/server/env";
import { getOverview } from "@/server/unraid/service";
import { getDiagnostics } from "@/server/metrics-service";
import { enrichedOverview } from "@/server/docker/updates";
import { getHelperStatus } from "@/server/update/helper-client";
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
}

export async function loadBundle(): Promise<AgentDataBundle> {
  const [overview, diagnostics, updates, automation, projects] = await Promise.all([
    getOverview("15m").catch(() => null),
    getDiagnostics().catch(() => null),
    enrichedOverview().catch(() => null),
    getAutomationStatus().catch(() => null),
    listProjects().catch(() => null),
  ]);
  return { overview, diagnostics, updates, automation, projects };
}

/* ---- summary -------------------------------------------------------------- */

export interface AgentSummary {
  health: { level: string | null; reasons: string[] };
  cpu: { percent: number | null; load5: number | null };
  memory: { percent: number | null; usedBytes: number | null; totalBytes: number | null };
  storage: { state: string | null; usedBytes: number | null; totalBytes: number | null };
  docker: { running: number | null; total: number | null; unhealthy: number | null };
  vms: { total: number; running: number } | null;
  updatesAvailable: number | null;
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
