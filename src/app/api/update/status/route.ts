import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getHelperStatus, isUpdatePhaseActive } from "@/server/update/helper-client";
import { checkForUpdate } from "@/server/actions/update-check";
import { getBuildInfo } from "@/server/version";

export const dynamic = "force-dynamic";

/**
 * Unified update status for the Settings → Updates screen:
 * running build, GHCR release check, and the local update-helper state
 * (phase machine, last result, registry pull availability). No secrets.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;

  const build = getBuildInfo();
  const [release, helper] = await Promise.all([
    checkForUpdate().catch(() => null),
    getHelperStatus(),
  ]);

  return NextResponse.json(
    {
      build,
      release,
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
        pullAvailable: helper.pullAvailable,
        /** In-app update button availability (token configured server-side). */
        requestEnabled: helper.configured && helper.reachable && Boolean(process.env.UPDATE_HELPER_TOKEN),
      },
      updateInProgress: isUpdatePhaseActive(helper.phase),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
