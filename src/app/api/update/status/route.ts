import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getHelperStatus, isUpdatePhaseActive } from "@/server/update/helper-client";
import { checkForUpdate } from "@/server/actions/update-check";
import { getBuildInfo } from "@/server/version";
import { readUpdateHistory, maybeRecordFromHelper, validatedVersions } from "@/server/update/history";
import { buildReleaseChain, readBootMarker } from "@/server/update/release-chain";
import { resolveEffectiveRelease } from "@/server/update/effective-release";
import { enrichedOverview } from "@/server/docker/updates";

export const dynamic = "force-dynamic";

/**
 * Unified update status for the Settings → Updates screen (v0.7.1):
 * running build, GHCR release check, local-image discovery (usable
 * without a host GHCR login), version/digest consistency flags, the
 * local helper state, and the persisted update history. No secrets.
 *
 * `?force=1` (the manual "Check for updates" button) bypasses the release
 * check's cache and performs a fresh remote registry lookup. Background
 * polls keep using the cache. Local images are discovery-only: without a
 * registry answer the status stays unknown/degraded — local images are
 * never presented as an authoritative "latest release".
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const force = request.nextUrl.searchParams.get("force") === "1";

  const build = getBuildInfo();
  const [release, helper] = await Promise.all([
    checkForUpdate({ force }).catch(() => null),
    getHelperStatus(),
  ]);

  /* Release discovery ----------------------------------------------------
   * Registry answer (now anonymous-capable) is authoritative; locally
   * present images are discovery-only and never report "up to date". */
  const { release: effectiveRelease, source: releaseSource } = resolveEffectiveRelease(
    release,
    helper,
    build.version,
  );

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
  // Rollback candidates: successfully-run releases whose images are still
  // present locally (the helper's local list is the presence oracle).
  const rollbackCandidates = validatedVersions(history).filter((tag) =>
    helper.reachable ? helper.localVersions.includes(tag) : false,
  );

  /* Release-chain verdict (v0.7.14): tag → CI → GHCR → credential →
   * remote pull → running digest, plus the boot-persistence marker. */
  const enriched = await enrichedOverview().catch(() => null);
  const appContainer = enriched?.containers.find((entry) => entry.name === "unraid-dashboard") ?? null;
  const bootMarker = await readBootMarker().catch(() => null);
  const releaseChain = buildReleaseChain({ helper, appContainer, history, bootMarker });

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
        requireRemote: helper.requireRemote,
        /** In-app update button availability (token configured server-side). */
        requestEnabled:
          helper.configured &&
          helper.reachable &&
          Boolean(process.env.UPDATE_HELPER_TOKEN) &&
          Boolean(effectiveRelease?.latestTag),
      },
      consistency,
      releaseChain,
      updateInProgress: isUpdatePhaseActive(helper.phase),
      rollbackCandidates,
      history: history.slice(0, 10),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
