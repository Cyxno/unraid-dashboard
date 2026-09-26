import { getEnvSafe } from "@/server/env";
import { getHelperStatus } from "@/server/update/helper-client";
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
  const raw = process.env.CUSTOM_DEPLOY_CONTAINERS ?? "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/** Extra operator-declared high-risk container name fragments. */
function extraHighRisk(): string[] {
  const raw = process.env.HIGH_RISK_CONTAINERS ?? "";
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
async function ensureChecks(images: Array<{ image: string }>, force: boolean): Promise<void> {
  const existing = globalStore.__dockerRefreshInFlight;
  if (existing) {
    await existing;
    return;
  }
  const cache = checkCache();
  const targets = images
    .map((entry) => entry.image)
    .filter((image) => {
      if (force) return true;
      const cached = cache.get(image);
      return !cached || Date.now() - cached.at >= CHECK_TTL_MS;
    });
  if (targets.length === 0) return;

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
  await globalStore.__dockerRefreshInFlight;
}

/** Full overview: managed model for every container + storage context. */
export async function updatesOverview(options: { refresh?: boolean } = {}): Promise<{
  available: boolean;
  reason?: string;
  containers: ManagedContainer[];
  storage: { mode: string; source: string | null };
  checkedAt: string;
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
    };
  }

  await ensureChecks(
    inventory.containers.filter((facts) => facts.repoDigests.length > 0),
    options.refresh === true,
  );

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
    return buildManagedContainer({
      facts,
      customDeployContainers: customDeployContainers(),
      extraHighRisk: extraHighRisk(),
      check,
      checkedAt,
    });
  });

  return {
    available: true,
    containers,
    storage: inventory.storage,
    checkedAt,
  };
}

/** Test hooks. */
export function resetUpdateDetection(): void {
  globalStore.__dockerUpdateCache = undefined;
  globalStore.__dockerInventoryCache = undefined;
  globalStore.__dockerRefreshInFlight = null;
}
