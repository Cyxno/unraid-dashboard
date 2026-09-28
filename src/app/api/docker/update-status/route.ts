import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getContainerJob } from "@/server/update/helper-client";
import { hasContainerRecord, recordContainerUpdate } from "@/server/update/history";

export const dynamic = "force-dynamic";

/**
 * Job status for one container (phases, result, stale detection). When the
 * machine settles, the outcome is reconciled into the persisted update
 * history exactly once (startedAt + target dedupe) — the track record the
 * auto-eligibility model and the history UI read (v0.8.0).
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const name = request.nextUrl.searchParams.get("name") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name)) {
    return NextResponse.json(
      { error: "Invalid container name." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const job = await getContainerJob(name);

  if (job?.finishedAt && job.startedAt && job.lastResult) {
    const recorded = await hasContainerRecord(job.startedAt, name).catch(() => true);
    if (!recorded) {
      const result = job.lastResult.result;
      await recordContainerUpdate({
        startedAt: job.startedAt,
        actor: "helper-machine",
        target: name,
        scope: "container",
        adapter: "helper",
        image: job.lastResult.image ?? "unknown",
        previousImage: null,
        digest: job.lastResult.imageId ?? null,
        durationMs: job.lastResult.durationMs ?? 0,
        phasesReached: (job.phases ?? []).map((phase) => phase.phase),
        result: result === "success" || result === "no-change" ? "success" : result === "rolled-back" ? "rolled-back" : "failed",
        rollbackPerformed: result === "rolled-back",
        ...(job.lastResult.error ? { error: job.lastResult.error } : {}),
      }).catch(() => {});
    }
  }

  return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
}
