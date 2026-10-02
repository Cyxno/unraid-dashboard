import type { UpdateStatus } from "@/server/actions/update-check";
import { compareSemver } from "@/server/update/helper-client";

/**
 * Resolves the "latest release" the Updates screen presents.
 *
 * Source priority:
 * 1. **registry** — the GHCR check answered (available / up-to-date).
 *    Authoritative.
 * 2. **local-fallback** — the registry check is unavailable (no answer /
 *    degraded): locally present helper images drive *discovery* only. A
 *    newer local image is surfaced as a hint, but this is NEVER
 *    "up to date": without a remote answer the status stays "unknown"
 *    with an explicit non-authoritative reason.
 * 3. **none** — no remote answer and no local discovery.
 *
 * v1.1.2 regression this replaces: a v1.1.0 install with no GHCR_TOKEN got
 * `latestTag` from the newest LOCAL image, compared equal to the running
 * version and presented "up to date, source: local images" — masking the
 * remote release entirely.
 */

export type ReleaseSource = "registry" | "local-fallback" | "none";

export interface EffectiveRelease {
  release: UpdateStatus;
  source: ReleaseSource;
}

export interface HelperLocalDiscovery {
  reachable: boolean | null;
  localVersions: string[];
  currentVersion: string | null;
  pullAvailable: boolean | null;
}

export function resolveEffectiveRelease(
  registryRelease: UpdateStatus | null,
  helper: HelperLocalDiscovery,
  runningVersion: string,
): EffectiveRelease {
  if (registryRelease && (registryRelease.status === "available" || registryRelease.status === "up-to-date")) {
    return { release: registryRelease, source: "registry" };
  }

  const newestLocal = helper.reachable ? (helper.localVersions[0] ?? null) : null;
  if (newestLocal) {
    const comparison =
      runningVersion !== "unknown" ? compareSemver(newestLocal, runningVersion) : 0;
    const reason =
      "Registry check unavailable — discovered from locally present images; not an authoritative latest release.";
    return {
      release: {
        status: comparison > 0 ? "available" : "unknown",
        reason,
        latestTag: comparison > 0 ? newestLocal : null,
        latestManifestDigest: null,
        latestRevisionSha: null,
        checkedAt: new Date().toISOString(),
        registry: {
          tokenConfigured: registryRelease?.registry.tokenConfigured ?? false,
          reachable: registryRelease?.registry.reachable ?? null,
          authorized: registryRelease?.registry.authorized ?? null,
          reason: registryRelease?.reason ?? reason,
        },
      },
      source: "local-fallback",
    };
  }

  if (registryRelease) return { release: registryRelease, source: "none" };
  return {
    release: {
      status: "unknown",
      reason: "Update check failed — no registry answer and no local image discovery.",
      latestTag: null,
      latestManifestDigest: null,
      latestRevisionSha: null,
      checkedAt: new Date().toISOString(),
      registry: { tokenConfigured: false, reachable: null, authorized: null, reason: null },
    },
    source: "none",
  };
}
