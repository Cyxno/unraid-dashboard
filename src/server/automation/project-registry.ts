import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { getEnvSafe } from "@/server/env";
import { listProjects, resetProjectService, projectPlan, type ProjectSummary } from "@/server/docker/project-service";

/**
 * Live Compose project registry (v0.8.0): tracks each project's config
 * hash over time so plan invalidation is event-driven rather than guessed.
 *
 * The hash is computed HELPER-side (sha256 over ordered config-file
 * contents; env values never read). The app polls on a bounded interval
 * and on demand — no broad filesystem watching, no /mnt/user recursion.
 */

const REGISTRY_FILE = "project-registry.json";
const POLL_MS = 15 * 60_000;
const MAX_PROJECTS = 50;

export interface ProjectRegistryEntry {
  name: string;
  hash: string | null;
  lastSeen: string;
  lastChanged: string | null;
  configChanged: boolean;
  /** Which observed hash the current plan was derived from. */
  planHashBasis: string | null;
}

interface RegistryFile {
  projects: Record<string, ProjectRegistryEntry>;
  lastPollAt: string | null;
}

const globalStore = globalThis as unknown as {
  __projectRegistry?: RegistryFile | null;
  __projectRegistryPollInFlight?: Promise<RegistryFile> | null;
};

async function registryPath(): Promise<string> {
  return `${getEnvSafe().AUDIT_DIR}/${REGISTRY_FILE}`;
}

export async function loadRegistry(): Promise<RegistryFile> {
  if (globalStore.__projectRegistry) return globalStore.__projectRegistry;
  let file: RegistryFile | null = null;
  try {
    file = JSON.parse(await readFile(await registryPath(), "utf8")) as RegistryFile;
  } catch {
    file = null;
  }
  const registry = file && typeof file.projects === "object" ? file : { projects: {}, lastPollAt: null };
  globalStore.__projectRegistry = registry;
  return registry;
}

async function saveRegistry(registry: RegistryFile): Promise<void> {
  globalStore.__projectRegistry = registry;
  const path = await registryPath();
  await mkdir(getEnvSafe().AUDIT_DIR, { recursive: true }).catch(() => {});
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(registry, null, 2), { mode: 0o600 });
  await rename(tmp, path).catch(async () => {
    await writeFile(path, JSON.stringify(registry, null, 2), { mode: 0o600 });
  });
}

/** Test hook. */
export function resetProjectRegistry(): void {
  globalStore.__projectRegistry = null;
  globalStore.__projectRegistryPollInFlight = null;
}

/**
 * One registry poll: hash every known project via the helper and record
 * changes. Never throws — polling failures leave the registry untouched
 * and surface as `stale: true`.
 */
export async function pollProjectRegistry(force = false): Promise<RegistryFile> {
  if (globalStore.__projectRegistryPollInFlight) return globalStore.__projectRegistryPollInFlight;
  const run = async (): Promise<RegistryFile> => {
    const registry = await loadRegistry();
    const now = new Date().toISOString();
    if (!force && registry.lastPollAt && Date.now() - Date.parse(registry.lastPollAt) < POLL_MS) {
      return registry;
    }
    const { projects } = await listProjects();
    for (const project of projects.slice(0, MAX_PROJECTS)) {
      const existing = registry.projects[project.name];
      // Pipeline-owned projects are observed but never hashed/mutated.
      if (project.pipelineOwned) {
        registry.projects[project.name] = {
          name: project.name,
          hash: null,
          lastSeen: now,
          lastChanged: existing?.lastChanged ?? null,
          configChanged: false,
          planHashBasis: null,
        };
        continue;
      }
      const hashResult = await fetchProjectHash(project.name);
      const entry: ProjectRegistryEntry = {
        name: project.name,
        hash: hashResult?.hash ?? existing?.hash ?? null,
        lastSeen: now,
        lastChanged: existing?.lastChanged ?? null,
        configChanged: existing?.configChanged ?? false,
        planHashBasis: existing?.planHashBasis ?? null,
      };
      if (existing?.hash && hashResult?.hash && existing.hash !== hashResult.hash) {
        entry.lastChanged = now;
        entry.configChanged = true; // invalidates any cached/queued plan
      }
      registry.projects[project.name] = entry;
    }
    // Projects that disappeared keep their last real sighting; views show
    // staleness via lastSeen age. Nothing to do here.
    registry.lastPollAt = now;
    await saveRegistry(registry);
    return registry;
  };
  globalStore.__projectRegistryPollInFlight = run().finally(() => {
    globalStore.__projectRegistryPollInFlight = null;
  });
  return globalStore.__projectRegistryPollInFlight;
}

async function fetchProjectHash(project: string): Promise<{ hash: string | null } | null> {
  const config = (await import("@/server/env")).getEnvSafe();
  if (!config.UPDATE_HELPER_URL) return null;
  try {
    const response = await fetch(`${config.UPDATE_HELPER_URL}/compose-project-hash?project=${encodeURIComponent(project)}`, {
      headers: { authorization: `Bearer ${config.UPDATE_HELPER_TOKEN ?? ""}` },
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { hash?: string | null };
    return { hash: body.hash ?? null };
  } catch {
    return null;
  }
}

export interface ProjectRegistryView {
  projects: Array<
    ProjectRegistryEntry & {
      summary?: Pick<ProjectSummary, "healthState" | "serviceCount" | "pipelineOwned">;
    }
  >;
  lastPollAt: string | null;
  stale: boolean;
}

/** Registry view for the UI/Operations: last poll + per-project status. */
export async function projectRegistryView(): Promise<ProjectRegistryView> {
  const registry = await pollProjectRegistry().catch(() => null);
  const fallback = registry ?? (await loadRegistry());
  const { projects } = await listProjects().catch(() => ({ projects: [] as ProjectSummary[] }));
  const byName = new Map(projects.map((project) => [project.name, project]));
  const stale = !fallback.lastPollAt || Date.now() - Date.parse(fallback.lastPollAt) > 3 * POLL_MS;
  return {
    projects: Object.values(fallback.projects)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const summary = byName.get(entry.name);
        return {
          ...entry,
          summary: summary ? { healthState: summary.healthState, serviceCount: summary.serviceCount, pipelineOwned: summary.pipelineOwned } : undefined,
        };
      }),
    lastPollAt: fallback.lastPollAt,
    stale,
  };
}

/**
 * Plan invalidation: when a project's config changed since the plan was
 * derived, the next plan call forces a fresh helper derivation and clears
 * the changed flag only after a successful fresh derivation.
 */
export async function planWithInvalidation(project: string) {
  const registry = await loadRegistry();
  const entry = registry.projects[project];
  if (entry?.configChanged) {
    resetProjectService(); // cached graphs + plans are stale by definition
  }
  const result = await projectPlan(project);
  if (result.available && entry?.configChanged) {
    const hashResult = await fetchProjectHash(project);
    if (hashResult?.hash) {
      entry.planHashBasis = hashResult.hash;
      entry.configChanged = false;
      await saveRegistry(registry);
    }
  }
  return result;
}

/** Marks the basis a plan was derived from (called by the plan route). */
export async function recordPlanBasis(project: string, hash: string | null): Promise<void> {
  if (!hash) return;
  const registry = await loadRegistry();
  const entry = registry.projects[project];
  if (entry) {
    entry.planHashBasis = hash;
    await saveRegistry(registry);
  }
}
