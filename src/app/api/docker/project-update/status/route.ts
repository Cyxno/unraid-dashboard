import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getProjectJob } from "@/server/update/helper-client";
import { hasContainerRecord, recordContainerUpdate } from "@/server/update/history";

export const dynamic = "force-dynamic";

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/**
 * Project update job status (v0.7.13). When the machine settles, the
 * outcome is reconciled into the persisted update history exactly once
 * (dedupe key: machine startedAt + project target) — the same pattern the
 * self-update machine uses to survive dashboard replacements.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const project = (url.searchParams.get("project") ?? "").trim();
  if (!PROJECT_RE.test(project)) {
    return NextResponse.json({ error: "Valid project name required." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const job = await getProjectJob(project);
  if (!job) {
    return NextResponse.json({ job: null }, { headers: { "cache-control": "no-store" } });
  }

  if (job.finishedAt && job.startedAt && job.lastResult) {
    const recorded = await hasContainerRecord(job.startedAt, `project:${project}`).catch(() => true);
    if (!recorded) {
      const result = job.lastResult.result;
      await recordContainerUpdate({
        startedAt: job.startedAt,
        actor: "helper-machine",
        target: `project:${project}`,
        scope: "project",
        adapter: "compose-project",
        image: (job.lastResult.services ?? []).join(",") || "(unknown)",
        previousImage: null,
        durationMs: job.lastResult.durationMs ?? 0,
        phasesReached: (job.phases ?? []).map((phase) => phase.phase),
        result: result === "success" ? "success" : result === "rolled-back" ? "rolled-back" : "failed",
        rollbackPerformed: String(result).includes("rolled-back"),
        ...(job.lastResult.error ? { error: job.lastResult.error } : {}),
      }).catch(() => {});
    }
  }

  return NextResponse.json({ job }, { headers: { "cache-control": "no-store" } });
}
