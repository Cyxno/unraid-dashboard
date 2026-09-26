import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getHelperStatus, isUpdatePhaseActive, compareSemver } from "@/server/update/helper-client";
import { checkForUpdate } from "@/server/actions/update-check";
import { getBuildInfo } from "@/server/version";
import { readUpdateHistory, maybeRecordFromHelper } from "@/server/update/history";

export const dynamic = "force-dynamic";

/**
 * Unified update status for the Settings → Updates screen (v0.7.1):
 * running build, GHCR release check, local-image discovery (usable
 * without a host GHCR login), version/digest consistency flags, the
 * local helper state, and the persisted update history. No secrets.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;

  const build = getBuildInfo();
  const [release, helper] = await Promise.all([
    checkForUpdate().catch(() => null),
    getHelperStatus(),
  ]);

  /* Release discovery ---------------------------------------------------
   * Registry check (GHCR_TOKEN) when available; otherwise the helper's
   * locally present semver images drive discovery — same validation
   * applies on apply (label match, newer-only, single-flight). */
  let effectiveRelease = release;
  let releaseSource: "registry" | "local" | "none" = "none";
  if (release?.status === "available" || release?.status === "up-to-date") {
    releaseSource = "registry";
  } else if (helper.reachable && helper.localVersions.length > 0) {
    const newestLocal = helper.localVersions[0] ?? null;
    const comparison = newestLocal && build.version !== "unknown" ? compareSemver(newestLocal, build.version) : 0;
    effectiveRelease = {
      status: comparison > 0 ? "available" : comparison === 0 ? "up-to-date" : "unknown",
      reason: comparison > 0 ? `Newer locally present image: ${newestLocal}.` : undefined,
      latestTag: comparison > 0 ? newestLocal : (helper.currentVersion ?? newestLocal),
      latestManifestDigest: null,
      latestRevisionSha: null,
      checkedAt: new Date().toISOString(),
      registry: {
        tokenConfigured: release?.registry.tokenConfigured ?? false,
        reachable: release?.registry.reachable ?? null,
        authorized: release?.registry.authorized ?? null,
        reason: release?.reason ?? "Registry check unavailable — using locally present images.",
      },
    };
    releaseSource = "local";
  }

  /* Version/digest consistency (informational, not incident flags) ------- */
  const consistency = {
    versionMatchesTag:
      helper.currentVersion !== null && build.version !== "unknown"
        ? helper.currentVersion === build.version
        : null,
    /** Running git SHA vs the image's org.opencontainers.image.revision. */
    shaMatchesRevision:
      helper.currentRevision !== null && build.gitSha !== null
        ? helper.currentRevision.startsWith(build.gitSha) || build.gitSha.startsWith(helper.currentRevision)
        : null,
    runningDigest: helper.currentImageId,
    registryDigest: release?.latestManifestDigest ?? null,
    locallyBuiltOnly: helper.reachable === true && helper.pullAvailable === false,
    unknownRegistryState: release?.registry.authorized === null || release === null,
    summary: "", // filled below
  };
  const notes: string[] = [];
  if (consistency.versionMatchesTag === false) notes.push("running version differs from the image's OCI version label");
  if (consistency.shaMatchesRevision === false) notes.push("running git SHA differs from the image's OCI revision");
  if (consistency.locallyBuiltOnly) notes.push("host cannot pull from GHCR — running locally built images");
  if (consistency.unknownRegistryState) notes.push("registry state unknown (no server-side GHCR token)");
  consistency.summary = notes.length > 0 ? notes.join("; ") : "consistent";

  /* Persist any helper-recorded update result not yet in history ---------- */
  await maybeRecordFromHelper(helper).catch(() => {});
  const history = await readUpdateHistory().catch(() => []);

  return NextResponse.json(
    {
      build,
      release: effectiveRelease,
      releaseSource,
      helper: {
        configured: helper.configured,
        reachable: helper.reachable,
        reason: helper.reason,
        helperVersion: helper.helperVersion,
        phase: helper.phase,
        detail: helper.detail,
        startedAt: helper.startedAt,
        finishedAt: helper.finishedAt,
        log: helper.log,
        lock: helper.lock,
        lastUpdate: helper.lastUpdate,
        currentImage: helper.currentImage,
        currentVersion: helper.currentVersion,
        currentImageId: helper.currentImageId,
        localVersions: helper.localVersions,
        pullAvailable: helper.pullAvailable,
        /** In-app update button availability (token configured server-side). */
        requestEnabled:
          helper.configured &&
          helper.reachable &&
          Boolean(process.env.UPDATE_HELPER_TOKEN) &&
          Boolean(effectiveRelease?.latestTag),
      },
      consistency,
      updateInProgress: isUpdatePhaseActive(helper.phase),
      history: history.slice(0, 10),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
