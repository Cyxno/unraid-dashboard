import type { ManagedContainer } from "./model";

/**
 * Project-aware Compose model (v0.7.13): groups compose-managed containers
 * into projects and derives a read-only update plan per project.
 *
 * Pure module — no docker access. Dependency data comes from the helper's
 * `docker compose config` parse (depends_on as configured, never guessed
 * from names). If the dependency graph is ambiguous the plan is marked
 * unsupported instead of inventing an order.
 */

export interface ComposeServiceNode {
  /** Service name as configured in the compose file. */
  service: string;
  /** Container names running this service (usually exactly one). */
  containers: string[];
  container: ManagedContainer;
}

export interface ComposeProject {
  name: string;
  workingDir: string | null;
  configFiles: string[];
  services: ComposeServiceNode[];
  /** Networks shared with other projects (informational). */
  networks: string[];
  /** Volume source paths shared with other projects (informational). */
  sharedVolumes: string[];
  pipelineOwned: boolean;
  healthState: "healthy" | "degraded" | "down" | "mixed" | "starting";
}

export interface ProjectPlanStep {
  container: string;
  service: string;
  image: string;
  update_available: boolean;
  risk: "LOW" | "MEDIUM" | "HIGH";
  /** Depends-on service names as configured (informational context). */
  depends_on: string[];
}

export interface ProjectUpdatePlan {
  project: string;
  supported: boolean;
  /** Human reason when supported=false. */
  unsupportedReason: string | null;
  /** Safe update order: dependencies before dependents (from depends_on). */
  order: ProjectPlanStep[];
  blocked: Array<{ container: string; service: string; reason: string }>;
  /** Project contains pipeline-owned/high-risk/immature members → refuse. */
  mutationAllowed: boolean;
  rollbackReady: boolean;
  /** Stable hash of the plan (order + targets) the mutation must echo. */
  planHash: string;
  derivedAt: string;
}

/** Groups managed containers into compose projects. */
export function buildProjects(containers: ManagedContainer[]): ComposeProject[] {
  const byProject = new Map<string, ManagedContainer[]>();
  for (const container of containers) {
    const source = container.management_source;
    const match = source.match(/^(?:compose|pipeline project list):([^/]+)\//);
    const isProject = match && (container.management_type === "compose" || container.management_type === "pipeline_owned");
    const project = isProject ? match![1]! : null;
    if (!project) continue;
    const list = byProject.get(project) ?? [];
    list.push(container);
    byProject.set(project, list);
  }

  const projects: ComposeProject[] = [];
  for (const [name, list] of byProject) {
    const networks = new Set<string>();
    const volumes = new Set<string>();
    for (const container of list) {
      // Networks/volumes are attached to the container model as optional
      // extension fields supplied by updates.ts (helper facts join).
      const ext = container as ManagedContainer & { networks?: string[]; volumeSources?: string[] };
      for (const network of ext.networks ?? []) networks.add(network);
      for (const volume of ext.volumeSources ?? []) volumes.add(volume);
    }
    const states = new Set(list.map((c) => (c.health === null ? (c as { state?: string }).state ?? "unknown" : c.health)));
    const allRunning = list.every((c) => ((c as { state?: string }).state ?? "running") === "running");
    const healthState: ComposeProject["healthState"] = allRunning
      ? list.some((c) => c.health === "unhealthy")
        ? "degraded"
        : list.some((c) => c.health === "starting")
          ? "starting"
          : "healthy"
      : states.has("running")
        ? "mixed"
        : "down";
    projects.push({
      name,
      workingDir: workingDirOf(list),
      configFiles: configFilesOf(list),
      services: list.map((container) => ({
        service: serviceOf(container),
        containers: [container.name],
        container,
      })),
      networks: [...networks].sort(),
      sharedVolumes: [...volumes].sort(),
      pipelineOwned: list.some((c) => c.management_type === "pipeline_owned"),
      healthState,
    });
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

function serviceOf(container: ManagedContainer): string {
  const match = container.management_source.match(/^[^:]+:[^/]+\/(.+)$/);
  return match?.[1] ?? container.name;
}

function workingDirOf(list: ManagedContainer[]): string | null {
  for (const container of list) {
    const ext = container as ManagedContainer & { composeWorkingDir?: string | null };
    if (ext.composeWorkingDir) return ext.composeWorkingDir;
  }
  return null;
}

function configFilesOf(list: ManagedContainer[]): string[] {
  for (const container of list) {
    const ext = container as ManagedContainer & { composeConfigFiles?: string[] | null };
    if (ext.composeConfigFiles && ext.composeConfigFiles.length > 0) return ext.composeConfigFiles;
  }
  return [];
}

/* ---- dependency ordering ----------------------------------------------------- */

/**
 * Topological order over the depends_on graph (dependencies first).
 * Returns null when the graph is ambiguous: a cycle, or an edge naming a
 * service that has no running container. Ordering is NEVER inferred from
 * service names.
 */
export function topologicalServiceOrder(
  services: string[],
  dependsOn: Record<string, string[]>,
): { order: string[] } | { order: null; reason: string } {
  const known = new Set(services);
  for (const [service, deps] of Object.entries(dependsOn)) {
    if (!known.has(service)) continue;
    for (const dep of deps) {
      if (!known.has(dep)) {
        return { order: null, reason: `service "${service}" depends on "${dep}", which has no running container in this project — dependency graph ambiguous` };
      }
    }
  }
  // Kahn's algorithm, deterministic (alphabetical among ready nodes).
  const remaining = new Set(services);
  const placed = new Set<string>();
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((service) => (dependsOn[service] ?? []).every((dep) => !known.has(dep) || placed.has(dep)))
      .sort();
    if (ready.length === 0) {
      return { order: null, reason: `dependency cycle between: ${[...remaining].sort().join(", ")}` };
    }
    for (const service of ready) {
      order.push(service);
      placed.add(service);
      remaining.delete(service);
    }
  }
  return { order };
}

/* ---- project update plan (read-only) ------------------------------------------ */

const BUILTIN_BLOCKED = new Set(["dumb", "dumbscope", "unraid-dashboard", "unraid-dashboard-helper", "watchtower"]);

function containerBlockReason(container: ManagedContainer, gate: { canUpdate: boolean; blockedReason: string | null }): string | null {
  if (container.management_type === "pipeline_owned") {
    return "Managed by external deployment pipeline";
  }
  if (container.management_type === "local_build" || container.update_status === "LOCAL_BUILD") {
    return "Locally built image — updated by its build pipeline, not the dashboard";
  }
  if (container.update_status === "PINNED") {
    return "Digest-pinned image";
  }
  if (container.risk === "HIGH") {
    return "HIGH risk service (database/auth/proxy/DNS/storage-critical) — project update never touches it";
  }
  if (BUILTIN_BLOCKED.has(container.name.toLowerCase())) {
    return "AIO / externally managed container";
  }
  if (!gate.canUpdate && gate.blockedReason) return gate.blockedReason;
  if (!container.update_available) return "Already up to date";
  return null;
}

/**
 * Builds the read-only update plan for one project. A project update is
 * only ever proposed when EVERY member is either updateable-through-the-
 * dashboard or already up to date: one high-risk, pipeline-owned or
 * blocked member refuses the whole plan (project automation must never
 * bypass per-service safety policy).
 */
export function buildProjectPlan(input: {
  project: ComposeProject;
  dependsOn: Record<string, string[]>;
  gate: (container: ManagedContainer) => { canUpdate: boolean; blockedReason: string | null };
  now?: string;
}): ProjectUpdatePlan {
  const { project, dependsOn, gate } = input;
  const now = input.now ?? new Date().toISOString();
  const blocked: ProjectUpdatePlan["blocked"] = [];
  const updateable: ComposeServiceNode[] = [];

  for (const node of project.services) {
    const reason = containerBlockReason(node.container, gate(node.container));
    if (reason) {
      blocked.push({ container: node.container.name, service: node.service, reason });
    } else {
      updateable.push(node);
    }
  }

  const orderResult = topologicalServiceOrder(
    project.services.map((node) => node.service),
    dependsOn,
  );

  const base = {
    project: project.name,
    derivedAt: now,
    blocked,
  };

  if (orderResult.order === null) {
    return {
      ...base,
      supported: false,
      unsupportedReason: orderResult.reason,
      order: [],
      mutationAllowed: false,
      rollbackReady: false,
      planHash: hashPlan({ project: project.name, steps: [], blocked }),
    };
  }

  const byService = new Map(project.services.map((node) => [node.service, node]));
  const order: ProjectPlanStep[] = [];
  for (const service of orderResult.order) {
    const node = byService.get(service);
    if (!node) continue; // defensive: graph covers exactly the project services
    if (blocked.some((entry) => entry.container === node.container.name)) continue;
    order.push({
      container: node.container.name,
      service: node.service,
      image: node.container.image,
      update_available: node.container.update_available,
      risk: node.container.risk,
      depends_on: dependsOn[service] ?? [],
    });
  }

  // Mutation policy: a project with any blocked member that is HIGH risk,
  // pipeline-owned or locally built refuses entirely (an operator may
  // still update a plain "up to date" member individually). "Up to date"
  // blockers do not refuse the plan; hard blockers do. An empty plan is
  // never "ready" — there is nothing validated to execute.
  const HARD_BLOCK = /pipeline|HIGH risk|Locally built|AIO|recreatable|pinned/i;
  const hasHardBlock = blocked.some((entry) => HARD_BLOCK.test(entry.reason));
  const rollbackReady =
    order.length > 0 &&
    order.every((step) => {
      const node = byService.get(step.service);
      return node ? node.container.rollback.ready : false;
    });

  return {
    ...base,
    supported: true,
    unsupportedReason: null,
    order,
    mutationAllowed: !project.pipelineOwned && !hasHardBlock && order.length > 0 && rollbackReady,
    rollbackReady,
    planHash: hashPlan({ project: project.name, steps: order, blocked }),
  };
}

/** Deterministic plan hash (FNV-1a) — mutation must echo the same plan. */
export function hashPlan(payload: unknown): string {
  const json = JSON.stringify(payload);
  let hash = 0x811c9dc5;
  for (let index = 0; index < json.length; index++) {
    hash ^= json.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
