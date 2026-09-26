import { getEnv } from "@/server/env";
import { getBuildInfo } from "@/server/version";

/**
 * Server-side image update status against GHCR (read-only).
 *
 * Only runs when a token with read:packages is configured (GHCR_TOKEN);
 * otherwise every field degrades to "unknown" instead of failing. The
 * token never leaves the server and is never logged.
 *
 * What is compared:
 * - running version (build provenance) vs latest semver tag on GHCR
 * - running git SHA vs the remote image's org.opencontainers.image.revision
 *   label (fetched from the image config blob) — detects re-pushed "same
 *   version, newer build" states
 * - manifest digest of the remote tag (traceability; the running
 *   container cannot know its own manifest digest, so equality is judged
 *   via the revision label)
 */

export interface UpdateStatus {
  status: "up-to-date" | "available" | "unknown";
  reason?: string;
  /** Latest semver tag on GHCR (e.g. "0.6.0"). */
  latestTag: string | null;
  /** OCI manifest digest of the latest tag, when resolvable. */
  latestManifestDigest: string | null;
  /** Git revision the remote image was built from, when resolvable. */
  latestRevisionSha: string | null;
  /** Registry connectivity/auth state (no secret material). */
  registry: {
    /** GHCR_TOKEN configured on the dashboard container. */
    tokenConfigured: boolean;
    /** Registry API answered. */
    reachable: boolean | null;
    /** Registry accepted the credential (when a token is configured). */
    authorized: boolean | null;
    reason: string | null;
  };
  checkedAt: string;
}

const globalStore = globalThis as unknown as {
  __dashboardUpdateCheck?: { at: number; value: UpdateStatus };
};

const REGISTRY = "https://ghcr.io";
const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

interface RegistryError extends Error {
  status?: number;
}

function parseVersion(tag: string): number[] | null {
  const cleaned = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(cleaned)) return null;
  return cleaned.split(".").map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < 3; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function unknownStatus(reason: string, checkedAt: string, tokenConfigured: boolean): UpdateStatus {
  return {
    status: "unknown",
    reason,
    latestTag: null,
    latestManifestDigest: null,
    latestRevisionSha: null,
    registry: { tokenConfigured, reachable: null, authorized: null, reason },
    checkedAt,
  };
}

async function registryFetch(
  path: string,
  token: string,
  accept?: string,
  method: "GET" | "HEAD" = "GET",
): Promise<Response> {
  const response = await fetch(`${REGISTRY}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      ...(accept ? { accept } : {}),
    },
    method,
    signal: AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) {
    const error = new Error(`GHCR responded with HTTP ${response.status} for ${path}`) as RegistryError;
    error.status = response.status;
    throw error;
  }
  return response;
}

interface OciManifest {
  config?: { digest?: string };
  manifests?: unknown[];
}
interface OciConfig {
  config?: { Labels?: Record<string, string> };
}

/** Resolves version/digest/revision info for the newest semver tag. */
async function fetchLatestFromRegistry(token: string, image: string): Promise<{
  latestTag: string;
  manifestDigest: string | null;
  revisionSha: string | null;
}> {
  const tagsResponse = await registryFetch(`/v2/${image}/tags/list`, token);
  const body = (await tagsResponse.json()) as { tags?: string[] };
  const semverTags = (body.tags ?? [])
    .map((tag) => ({ tag, version: parseVersion(tag) }))
    .filter((entry): entry is { tag: string; version: number[] } => entry.version !== null)
    .sort((a, b) => compareVersions(b.version, a.version));
  const latest = semverTags[0];
  if (!latest) {
    throw new Error("No semver tags on the registry.");
  }

  // Manifest digest for traceability.
  let manifestDigest: string | null = null;
  let revisionSha: string | null = null;
  try {
    const manifestResponse = await registryFetch(
      `/v2/${image}/manifests/${latest.tag}`,
      token,
      MANIFEST_ACCEPT,
    );
    manifestDigest = manifestResponse.headers.get("docker-content-digest");
    const manifest = (await manifestResponse.json()) as OciManifest;
    const configDigest = manifest.config?.digest;
    if (configDigest && configDigest.startsWith("sha256:")) {
      const configResponse = await registryFetch(`/v2/${image}/blobs/${configDigest}`, token);
      const config = (await configResponse.json()) as OciConfig;
      revisionSha = config.config?.Labels?.["org.opencontainers.image.revision"] ?? null;
    }
  } catch {
    // Digest/revision are supplementary — tags/list already succeeded.
  }

  return { latestTag: latest.tag, manifestDigest, revisionSha };
}

export async function checkForUpdate(): Promise<UpdateStatus> {
  const cached = globalStore.__dashboardUpdateCheck;
  // Check at most once per hour — never hammer GitHub.
  if (cached && Date.now() - cached.at < 3_600_000) {
    return cached.value;
  }

  const checkedAt = new Date().toISOString();
  const build = getBuildInfo();
  const env = (() => {
    try {
      return getEnv();
    } catch {
      return null;
    }
  })();

  if (!env?.GHCR_TOKEN) {
    const value = unknownStatus(
      "Update check not configured (GHCR_TOKEN missing) — the package is private.",
      checkedAt,
      false,
    );
    globalStore.__dashboardUpdateCheck = { at: Date.now(), value };
    return value;
  }

  try {
    const { latestTag, manifestDigest, revisionSha } = await fetchLatestFromRegistry(
      env.GHCR_TOKEN,
      env.GHCR_IMAGE,
    );
    const runningVersion = parseVersion(build.version);
    const remoteVersion = parseVersion(latestTag);

    let value: UpdateStatus;
    if (!runningVersion || !remoteVersion) {
      value = {
        ...unknownStatus("No comparable semver versions.", checkedAt, true),
        latestTag,
        latestManifestDigest: manifestDigest,
        latestRevisionSha: revisionSha,
        registry: { tokenConfigured: true, reachable: true, authorized: true, reason: null },
        checkedAt,
      };
    } else {
      const versionNewer = compareVersions(remoteVersion, runningVersion) > 0;
      // Same version but different revision → registry holds a newer
      // build of the same tag. SHAs may differ in length (short vs full).
      const revisionDiffers =
        !versionNewer &&
        build.gitSha !== null &&
        revisionSha !== null &&
        !revisionSha.startsWith(build.gitSha) &&
        !build.gitSha.startsWith(revisionSha);
      value = {
        status: versionNewer || revisionDiffers ? "available" : "up-to-date",
        reason: revisionDiffers ? "Same version, newer build on the registry." : undefined,
        latestTag,
        latestManifestDigest: manifestDigest,
        latestRevisionSha: revisionSha,
        registry: { tokenConfigured: true, reachable: true, authorized: true, reason: null },
        checkedAt,
      };
    }
    globalStore.__dashboardUpdateCheck = { at: Date.now(), value };
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update check failed.";
    const status = (error as RegistryError).status;
    const value: UpdateStatus = {
      ...unknownStatus(message, checkedAt, true),
      registry: {
        tokenConfigured: true,
        reachable: status !== 401 && status !== 403,
        authorized: status !== 401 && status !== 403,
        reason: message,
      },
    };
    globalStore.__dashboardUpdateCheck = { at: Date.now(), value };
    return value;
  }
}

/** Test hook. */
export function resetUpdateCheck(): void {
  globalStore.__dashboardUpdateCheck = undefined;
}
