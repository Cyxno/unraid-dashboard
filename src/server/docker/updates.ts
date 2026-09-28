import { getEnvSafe } from "@/server/env";
import { getHelperStatus, getHelperSnapshots } from "@/server/update/helper-client";
import { containerStatsBatch } from "@/server/update/history";
import { computeAutoEligibility, pilotAllowlist } from "@/server/update/eligibility";
import { checkRemoteDigest } from "./registry";
import {
  buildManagedContainer,
  compareDigests,
  localDigestOf,
  parseImageRef,
  type CheckOutcome,
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
const REFRESH_CONCURRENCY = 6;

const globalStore = globalThis as unknown as {
  __dockerUpdateCache?: Map<string, { at: number; outcome: RawCheck }>;
  __dockerInventoryCache?: { at: number; containers: ContainerFacts[]; storage: { mode: string; source: string | null } };
  __dockerRefreshInFlight?: Promise<void> | null;
};

function checkCache(): Map<string, { at: number; outcome: RawCheck }> {
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

/** Read-only inventory from the helper (the only Docker-socket component). */
export async function fetchInventory(): Promise<{
  containers: ContainerFacts[];
  storage: { mode: string; source: string | null };
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
    const body = (await response.json()) as {
      containers: ContainerFacts[];
      storage: { mode: string; source: string | null };
    };
    globalStore.__dockerInventoryCache = {
      at: Date.now(),
      containers: body.containers ?? [],
      storage: body.storage ?? { mode: "unknown", source: null },
    };
    return {
      containers: body.containers ?? [],
      storage: body.storage ?? { mode: "unknown", source: null },
    };
  } catch {
    return globalStore.__dockerInventoryCache
      ? { containers: globalStore.__dockerInventoryCache.containers, storage: globalStore.__dockerInventoryCache.storage }
      : null;
  }
}

/** Cached raw registry result per image (comparison happens per container). */
type RawCheck =
  | { kind: "digest"; remoteDigest: string }
  | { kind: "pinned"; remoteDigest: string }
  | { kind: "auth_required"; reason: string }
  | { kind: "failed"; reason: string };

async function checkImageWithCache(image: string, force: boolean): Promise<void> {
  const cache = checkCache();
  const cached = cache.get(image);
  if (!force && cached && Date.now() - cached.at < CHECK_TTL_MS) return;
  const env = getEnvSafe();
  const result = await checkRemoteDigest(image, env.GHCR_TOKEN);
  cache.set(image, { at: Date.now(), outcome: result });
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
  const targets = images
    .map((entry) => entry.image)
    .filter((image) => {
      if (force) return true;
      const cached = cache.get(image);
      return !cached || Date.now() - cached.at >= CHECK_TTL_MS;
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
}> {
  const checkedAt = new Date().toISOString();
  const inventory = await fetchInventory();
  if (!inventory) {
    return {
      available: false,
      reason: "Container inventory unavailable (update helper not configured or unreachable).",
      containers: [],
      storage: { mode: "unknown", source: null },
      checkedAt,
      checking: false,
      pending: 0,
    };
  }

  // Koude cache: start de sweep en antwoord direct (checking-state in de
  // UI); handmatige refresh wacht wel tot alle HEADs klaar zijn.
  const wait = options.wait ?? options.refresh === true;
  const sweep = await ensureChecks(
    inventory.containers.filter((facts) => facts.repoDigests.length > 0),
    options.refresh === true,
  );
  const checking = !wait && sweep.pending > 0;

  const containers = inventory.containers.map((facts) => {
    const localDigest = localDigestOf(facts);
    const raw = rawCheckFor(facts.image);
    // Join the cached remote digest with this container's local digest.
    const check: CheckOutcome | undefined = raw
      ? raw.kind === "digest"
        ? compareDigests(localDigest, raw.remoteDigest)
        : raw.kind === "pinned"
          ? { status: "PINNED", remoteDigest: raw.remoteDigest, localDigest }
          : raw.kind === "auth_required"
            ? { status: "AUTH_REQUIRED", remoteDigest: null, localDigest, reason: raw.reason }
            : { status: "CHECK_FAILED", remoteDigest: null, localDigest, reason: raw.reason }
      : undefined;
    const built = buildManagedContainer({
      facts,
      customDeployContainers: customDeployContainers(),
      extraHighRisk: extraHighRisk(),
      check,
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
