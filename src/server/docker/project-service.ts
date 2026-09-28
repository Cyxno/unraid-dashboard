import { getHelperComposeProject, type HelperComposeProject } from "@/server/update/helper-client";
import { updateGate } from "./policy";
import { enrichedOverview } from "./updates";
import { buildProjectPlan, buildProjects, hashPlan, type ComposeProject, type ProjectUpdatePlan } from "./projects";
import type { ManagedContainer } from "./model";

/**
 * Project service (v0.7.13): joins the managed-container overview with the
 * helper's compose-config dependency graphs into per-project update plans.
 *
 * Cache discipline: dependency graphs are parsed by the helper only when
 * missing/expired (30 min TTL per project) — no `compose config` runs on
 * UI polls. Plan derivation itself is pure and runs on cached inputs.
 */

const GRAPH_TTL_MS = 30 * 60_000;

interface GraphCacheEntry {
  at: number;
  graph: HelperComposeProject | null;
}

const globalStore = globalThis as unknown as {
  __composeGraphCache?: Map<string, GraphCacheEntry>;
  __composeProjectList?: { at: number; projects: ProjectSummary[] };
};

function graphCache(): Map<string, GraphCacheEntry> {
  if (!globalStore.__composeGraphCache) globalStore.__composeGraphCache = new Map();
  return globalStore.__composeGraphCache;
}

async function graphFor(project: string, force: boolean): Promise<HelperComposeProject | null> {
  const cache = graphCache();
  const cached = cache.get(project);
  if (!force && cached && Date.now() - cached.at < GRAPH_TTL_MS) return cached.graph;
  const graph = await getHelperComposeProject(project);
  cache.set(project, { at: Date.now(), graph });
  return graph;
}

export interface ProjectSummary {
  name: string;
  workingDir: string | null;
  configFiles: string[];
  pipelineOwned: boolean;
  healthState: ComposeProject["healthState"];
  serviceCount: number;
  services: Array<{
    container: string;
    service: string;
    image: string;
    state: string;
    health: string | null;
    risk: "LOW" | "MEDIUM" | "HIGH";
    updateStatus: string;
    managementType: string;
  }>;
  networks: string[];
  sharedVolumes: string[];
}

/** Projects view over the managed inventory (cheap; no compose parsing). */
export async function listProjects(force = false): Promise<{
  available: boolean;
  reason?: string;
  projects: ProjectSummary[];
  checkedAt: string;
}> {
  const overview = await enrichedOverview({ refresh: force });
  const checkedAt = overview.checkedAt;
  if (!overview.available) {
    return { available: false, reason: overview.reason, projects: [], checkedAt };
  }
  const projects = buildProjects(overview.containers);
  return {
    available: true,
    projects: projects.map((project) => ({
      name: project.name,
      workingDir: project.workingDir,
      configFiles: project.configFiles,
      pipelineOwned: project.pipelineOwned,
      healthState: project.healthState,
      serviceCount: project.services.length,
      services: project.services.map((node) => ({
        container: node.container.name,
        service: node.service,
        image: node.container.image,
        state: (node.container as ManagedContainer & { state?: string }).state ?? "unknown",
        health: node.container.health,
        risk: node.container.risk,
        updateStatus: node.container.update_status,
        managementType: node.container.management_type,
      })),
      networks: project.networks,
      sharedVolumes: project.sharedVolumes,
    })),
    checkedAt,
  };
}

export type ProjectPlanResult =
  | { available: false; reason: string }
  | { available: true; project: string; pipelineOwned: boolean; plan: ProjectUpdatePlan; graph: HelperComposeProject | null };

/** Read-only update plan for one project (compose-config derived order). */
export async function projectPlan(project: string, force = false): Promise<ProjectPlanResult> {
  const overview = await enrichedOverview({ refresh: force });
  if (!overview.available) {
    return { available: false, reason: overview.reason ?? "inventory unavailable" };
  }
  const projects = buildProjects(overview.containers);
  const target = projects.find((entry) => entry.name === project);
  if (!target) {
    return { available: false, reason: `unknown compose project: ${project}` };
  }
  const graph = target.pipelineOwned ? null : await graphFor(project, force);
  if (target.pipelineOwned) {
    return {
      available: true,
      project,
      pipelineOwned: true,
      graph: null,
      plan: {
        project,
        supported: false,
        unsupportedReason: "Managed by external deployment pipeline — dashboard never plans or executes updates here",
        order: [],
        blocked: target.services.map((node) => ({
          container: node.container.name,
          service: node.service,
          reason: "Managed by external deployment pipeline",
        })),
        mutationAllowed: false,
        rollbackReady: false,
        planHash: hashPlan({ project, steps: [], blocked: [] }),
        derivedAt: new Date().toISOString(),
      },
    };
  }
  if (!graph) {
    return {
      available: true,
      project,
      pipelineOwned: false,
      graph: null,
      plan: {
        project,
        supported: false,
        unsupportedReason: "Compose config unavailable (helper unreachable or project unreadable)",
        order: [],
        blocked: [],
        mutationAllowed: false,
        rollbackReady: false,
        planHash: hashPlan({ project, steps: [], blocked: [] }),
        derivedAt: new Date().toISOString(),
      },
    };
  }
  const plan = buildProjectPlan({
    project: target,
    dependsOn: graph.dependsOn ?? {},
    gate: updateGate,
  });
  return { available: true, project, pipelineOwned: false, plan, graph };
}

/** Test hook. */
export function resetProjectService(): void {
  globalStore.__composeGraphCache = undefined;
  globalStore.__composeProjectList = undefined;
}
