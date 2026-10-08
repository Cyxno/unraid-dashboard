import { getEnvSafe } from "@/server/env";
import { getHelperSnapshots } from "@/server/update/helper-client";
import { containerStatsBatch } from "@/server/update/history";
import { computeAutoEligibility, pilotAllowlist } from "@/server/update/eligibility";
import { checkRemoteDigest, type RegistryCheckResult } from "./registry";
import { describeInventoryIssues, helperInventorySchema } from "./helper-contract";
import {
  buildManagedContainer,
  updateVerdictForFacts,
  type ContainerFacts,
  type ManagedContainer,
} from "./model";

/**
 * Central update detection (Phases B–D): combines the helper's read-only
 * inventory with registry digest checks into the managed-container model.
 *
 * Cache discipline: per-image results live 4 hours (registry HEADs are
 * rate-limited); a manual refresh clears the cache but still serializes
 * checks with bounded concurrency so 60 containers never hammer a
 * registry. Checks NEVER pull images.
 */

const CHECK_TTL_MS = 4 * 60 * 60 * 1000;
/** Transient registry failures must not freeze update evidence for the
 *  full 4h TTL — the next sweep retries after 60s instead. */
const FAILED_CHECK_TTL_MS = 60 * 1000;
/** Helper-inventory last-known-good ceiling: beyond this age the helper is
 *  presumed unreachable-and-staying and the overview reports unavailable
 *  instead of presenting arbitrarily old container facts as fresh. */
export const INVENTORY_LKG_MAX_AGE_MS = 15 * 60 * 1000;

const REFRESH_CONCURRENCY = 6;

const globalStore = globalThis as unknown as {
  __dockerUpdateCache?: Map<string, { at: number; outcome: RawCheck; ttlMs: number }>;
  __dockerInventoryCache?: { at: number; containers: ContainerFacts[]; storage: { mode: string; source: string | null } };
  __dockerRefreshInFlight?: Promise<void> | null;
};

function checkCache(): Map<string, { at: number; outcome: RawCheck; ttlMs: number }> {
  if (!globalStore.__dockerUpdateCache) globalStore.__dockerUpdateCache = new Map();
  return globalStore.__dockerUpdateCache;
}

/** Custom-deploy containers from operator env (comma-separated names). */
function customDeployContainers(): string[] {
  const raw = process.env["CUSTOM_DEPLOY_CONTAINERS"] ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/** Extra operator-declared high-risk container name fragments. */
function extraHighRisk(): string[] {
  const raw = process.env["HIGH_RISK_CONTAINERS"] ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/** Read-only inventory from the helper (the only Docker-socket component).
 *  Returns the helper age (`at`) and a `degraded` marker when the cached
 *  last-known-good had to be served because the helper was unreachable —
 *  callers must never present that combination as fresh. */
export async function fetchInventory(): Promise<{
  containers: ContainerFacts[];
  storage: { mode: string; source: string | null };
  at: number;
  degraded: boolean;
} | null> {
  const env = getEnvSafe();
  if (!env.UPDATE_HELPER_URL) return null;
  try {
    const response = await fetch(`${env.UPDATE_HELPER_URL}/inventory`, {
      headers: { authorization: `Bearer ${env.UPDATE_HELPER_TOKEN ?? ""}` },
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = (await response.json()) as unknown;
    // Runtime contract validation (v1.3.16): a helper that drifts from the
    // expected shape is treated as unavailable — never ingested as facts.
    // The last-known-good dashboard-side cache keeps serving while the
    // helper recovers.
    const parsed = helperInventorySchema.safeParse(body);
    if (!parsed.success) {
      console.error(
        `[docker-updates] helper inventory contract violation: ${describeInventoryIssues(parsed.error)}`,
      );
      const cache = globalStore.__dockerInventoryCache;
      return cache ? { containers: cache.containers, storage: cache.storage, at: cache.at, degraded: true } : null;
    }
    const validated = parsed.data;
    globalStore.__dockerInventoryCache = {
      at: Date.now(),
      containers: validated.containers as unknown as ContainerFacts[],
      storage: validated.storage,
    };
    return {
      containers: validated.containers as unknown as ContainerFacts[],
      storage: validated.storage,
      at: Date.now(),
      degraded: false,
    };
  } catch {
    const cache = globalStore.__dockerInventoryCache;
    return cache ? { containers: cache.containers, storage: cache.storage, at: cache.at, degraded: true } : null;
  }
}

/** Pure TTL decision for a cached registry check (exported for tests). */
export function cacheTtlForOutcome(outcome: RawCheck): number {
  return outcome.kind === "failed" ? FAILED_CHECK_TTL_MS : CHECK_TTL_MS;
}

function entryFresh(entry: { at: number; ttlMs: number } | undefined): boolean {
  return Boolean(entry && Date.now() - entry.at < entry.ttlMs);
}

/** Cached raw registry result per image (comparison happens per container). */
type RawCheck = RegistryCheckResult;

async function checkImageWithCache(image: string, force: boolean): Promise<void> {
  const cache = checkCache();
  const cached = cache.get(image);
  if (!force && entryFresh(cached)) return;
  const env = getEnvSafe();
  const result = await checkRemoteDigest(image, env.GHCR_TOKEN);
  cache.set(image, { at: Date.now(), outcome: result, ttlMs: cacheTtlForOutcome(result) });
}

function rawCheckFor(image: string): RawCheck | null {
  const cached = checkCache().get(image);
  return cached ? cached.outcome : null;
}

/**
 * Ensures every given image has a fresh-enough cached check. force=true
 * re-HEADs everything (manual refresh); otherwise only missing/expired
 * entries are fetched. Bounded concurrency, single in-flight run.
 */
async function ensureChecks(images: Array<{ image: string }>, force: boolean): Promise<{ pending: number }> {
  const existing = globalStore.__dockerRefreshInFlight;
  if (existing) {
    await existing;
    return { pending: 0 };
  }
  const cache = checkCache();
  // Deduplicate per unique image ref (v1.3.9): 20 containers sharing one
  // image must produce ONE registry HEAD, not 20.
  const uniqueRefs = Array.from(new Set(images.map((entry) => entry.image)));
  const targets = uniqueRefs.filter((image) => {
    if (force) return true;
    return !entryFresh(cache.get(image));
  });
  if (targets.length === 0) return { pending: 0 };

  const run = async () => {
    let index = 0;
    const worker = async () => {
      while (index < targets.length) {
        const current = targets[index++];
        if (!current) break;
        await checkImageWithCache(current, true);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(REFRESH_CONCURRENCY, targets.length) }, worker),
    );
  };
  globalStore.__dockerRefreshInFlight = run().finally(() => {
    globalStore.__dockerRefreshInFlight = null;
  });
  if (force) {
    // Handmatige sweep: wacht tot alle HEADs klaar zijn.
    await globalStore.__dockerRefreshInFlight;
  }
  return { pending: targets.length };
}

/** Full overview: managed model for every container + storage context. */
export async function updatesOverview(options: { refresh?: boolean; wait?: boolean } = {}): Promise<{
  available: boolean;
  reason?: string;
  containers: ManagedContainer[];
  storage: { mode: string; source: string | null };
  checkedAt: string;
  checking: boolean;
  pending: number;
  inventoryAt: string | null;
  inventoryDegraded: boolean;
}> {
  const inventory = await fetchInventory();
  const inventoryUsable =
    inventory !== null &&
    (!inventory.degraded || Date.now() - inventory.at < INVENTORY_LKG_MAX_AGE_MS);
  if (!inventoryUsable) {
    return {
      available: false,
      reason: inventory
        ? "Container inventory is stale (update helper unreachable for too long) — refusing to present old facts as fresh."
        : "Container inventory unavailable (update helper not configured or unreachable).",
      containers: [],
      storage: { mode: "unknown", source: null },
      checkedAt: new Date().toISOString(),
      checking: false,
      pending: 0,
      inventoryAt: inventory ? new Date(inventory.at).toISOString() : null,
      inventoryDegraded: true,
    };
  }

  // checkedAt is the evidence timestamp: with a degraded (last-known-good)
  // inventory the facts are as old as the cache, never "now".
  const checkedAt = inventory.degraded
    ? new Date(inventory.at).toISOString()
    : new Date().toISOString();

  // Koude cache: start de sweep en antwoord direct (checking-state in de
  // UI); handmatige refresh wacht wel tot alle HEADs klaar zijn.
  // v1.3.9: every unique image ref is sweep-eligible — a container whose
  // local digest is missing needs the 404-vs-200 evidence too, otherwise
  // its state can never leave UNKNOWN (and true local builds would stay
  // unclassified). Dedup happens per unique ref inside ensureChecks.
  const wait = options.wait ?? options.refresh === true;
  const sweep = await ensureChecks(
    inventory.containers,
    options.refresh === true,
  );
  const checking = !wait && sweep.pending > 0;

  const containers = inventory.containers.map((facts) => {
    const raw = rawCheckFor(facts.image);
    const built = buildManagedContainer({
      facts,
      customDeployContainers: customDeployContainers(),
      extraHighRisk: extraHighRisk(),
      rawCheck: raw,
      checkedAt,
    });
    // Attach the read-only fact extensions (networks/volumes/compose paths)
    // the project model and UI need; not part of the validated schema.
    const extended = built as ManagedContainer & {
      state: string;
      networks: string[];
      volumeSources: string[];
      composeWorkingDir: string | null;
      composeConfigFiles: string[];
      unsupported: string[];
    };
    extended.state = facts.state;
    extended.networks = facts.networks ?? [];
    extended.volumeSources = facts.volumeSources ?? [];
    extended.composeWorkingDir = facts.labels["com.docker.compose.project.working_dir"] ?? null;
    extended.composeConfigFiles = (facts.labels["com.docker.compose.project.config_files"] ?? "")
      .split(",").map((f) => f.trim()).filter(Boolean);
    extended.unsupported = facts.unsupported ?? [];
    return built;
  });

  return {
    available: true,
    containers,
    storage: inventory.storage,
    checkedAt,
    checking,
    pending: sweep.pending,
    inventoryAt: new Date(inventory.at).toISOString(),
    inventoryDegraded: inventory.degraded,
  };
}

/** Shape of {@link enrichedOverview} (named for reuse in automation). */
export interface EnrichedOverview {
  available: boolean;
  reason?: string;
  containers: ManagedContainer[];
  storage: { mode: string; source: string | null };
  checkedAt: string;
  checking: boolean;
  pending: number;
  inventoryAt: string | null;
  inventoryDegraded: boolean;
}

/**
 * Enriches the overview with per-container history stats and the auto-
 * eligibility verdict (v0.7.13). Separated from updatesOverview so the
 * hot path stays cheap — history reads hit disk only here.
 */
export async function enrichedOverview(options: { refresh?: boolean; wait?: boolean } = {}): Promise<EnrichedOverview> {
  const overview = await updatesOverview(options);
  if (!overview.available) return overview;
  const allowlist = pilotAllowlist();
  const statsBatch = await containerStatsBatch();
  const containers = overview.containers.map((container) => {
    const stats = statsBatch.get(container.name) ?? { manualSuccesses: 0, rollbackCount: 0, lastSuccess: null, lastAttempt: null };
    const lastKnownGood = stats.lastSuccess;
    const withRollback = {
      ...container,
      rollback: {
        ...container.rollback,
        last_known_good: lastKnownGood?.image ?? container.rollback.last_known_good,
        validated_at: lastKnownGood?.at ?? container.rollback.validated_at,
      },
    };
    const eligibility = computeAutoEligibility({
      container: withRollback,
      manualSuccesses: stats.manualSuccesses,
      rollbackCount: stats.rollbackCount,
      pilotAllowlist: allowlist,
    });
    return { ...withRollback, autoEligible: eligibility.eligible, autoEligibilityReasons: eligibility.reasons };
  });
  return { ...overview, containers };
}

/** Snapshot presence list from the helper (rollback evidence, bounded). */
export async function fetchSnapshotPresence(): Promise<Record<string, boolean>> {
  const snapshots = await getHelperSnapshots();
  const map: Record<string, boolean> = {};
  for (const snapshot of snapshots ?? []) {
    if (snapshot.container) map[snapshot.container] = !snapshot.unreadable;
  }
  return map;
}

/** Test hooks. */
export function resetUpdateDetection(): void {
  globalStore.__dockerUpdateCache = undefined;
  globalStore.__dockerInventoryCache = undefined;
  globalStore.__dockerRefreshInFlight = null;
}

/**
 * Cached-only update summary (v0.9.9): reads the already-known inventory
 * and per-image check caches. NEVER fetches inventory, NEVER starts a
 * sweep, NEVER touches the registry — the Docker page anchor badge and
 * collapsed Updates summary consume this instead of updatesOverview().
 */
/**
 * Cache invalidation (v1.3.9, Fase 22): called after a successful update/
 * rollback so rows, counters, filter and summary refresh atomically from
 * the next sweep instead of serving a pre-update verdict. Clearing the
 * inventory cache too re-reads RepoDigests (the image changed on disk).
 */
export function invalidateUpdateState(imageRefs?: string[]): void {
  const cache = checkCache();
  if (imageRefs && imageRefs.length > 0) {
    for (const ref of imageRefs) cache.delete(ref);
  } else {
    cache.clear();
  }
  globalStore.__dockerInventoryCache = undefined;
}

export function updatesSummaryFromCache(): {
  available: boolean;
  lastCheckAt: string | null;
  ageSeconds: number | null;
  stale: boolean;
  checking: boolean;
  knownUpdatesCount: number | null;
  containersChecked: number;
  containersTotal: number | null;
  /** Canonical per-container verdicts — the ONLY source row badges, the
   *  Update filter and counters may use (v1.3.9). Served from cache; the
   *  endpoint never triggers a registry sweep. */
  containers: Array<{ id: string; name: string; update_available: boolean; update_status: string; status: string }>;
} {
  const checking = globalStore.__dockerRefreshInFlight != null;
  const inventory = globalStore.__dockerInventoryCache ?? null;
  if (!inventory) {
    return {
      available: false,
      lastCheckAt: null,
      ageSeconds: null,
      stale: false,
      checking,
      knownUpdatesCount: null,
      containersChecked: 0,
      containersTotal: null,
      containers: [],
    };
  }

  // Check recency comes from the newest per-image check entry (a completed
  // sweep stamps its entries); the inventory timestamp is the fallback.
  let newestCheckAt: number | null = null;
  for (const entry of checkCache().values()) {
    if (newestCheckAt == null || entry.at > newestCheckAt) newestCheckAt = entry.at;
  }
  const referenceAt = newestCheckAt ?? inventory.at;
  const ageSeconds = Math.max(0, Math.round((Date.now() - referenceAt) / 1000));
  const stale =
    checkCache().size === 0 ||
    ageSeconds * 1000 >= CHECK_TTL_MS ||
    // Old inventory facts (helper down) make the whole summary stale even
    // when registry checks are recent — container facts drive the verdicts.
    Date.now() - inventory.at >= INVENTORY_LKG_MAX_AGE_MS;

  let knownUpdatesCount = 0;
  let containersChecked = 0;
  const containers = inventory.containers.map((facts) => {
    // Same combined verdict the full overview uses (incl. management
    // policy) — no second derivation.
    const verdict = updateVerdictForFacts(facts, rawCheckFor(facts.image), customDeployContainers());
    if (verdict.update_status !== "UNKNOWN" && verdict.update_status !== "CHECK_FAILED") containersChecked += 1;
    if (verdict.update_available) knownUpdatesCount += 1;
    return {
      id: facts.id,
      name: facts.name,
      update_available: verdict.update_available,
      update_status: verdict.update_status,
      status: facts.status,
    };
  });

  return {
    available: true,
    lastCheckAt: new Date(referenceAt).toISOString(),
    ageSeconds,
    stale,
    checking,
    knownUpdatesCount,
    containersChecked,
    containersTotal: inventory.containers.length,
    containers,
  };
}
