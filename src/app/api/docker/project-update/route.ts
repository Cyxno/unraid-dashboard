import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { recordAudit } from "@/server/actions/audit";
import { getHelperStatus, isUpdatePhaseActive, requestProjectUpdate, getProjectJob } from "@/server/update/helper-client";
import { projectPlan } from "@/server/docker/project-service";

export const dynamic = "force-dynamic";

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/**
 * Sequential compose PROJECT update (v0.7.13). The dashboard re-derives the
 * plan at request time and requires it to still allow mutation — a drifted
 * plan (new update, changed risk, ambiguous graph) is refused with 409
 * before anything is dispatched. The helper independently re-validates all
 * policy and executes services one at a time, stopping on first failure.
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "trusted-local";
  const rate = checkWriteRate(`project-update:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json({ error: "Too many update requests — slow down." }, { status: 429, headers: { "cache-control": "no-store" } });
  }

  let body: { project?: unknown; confirm?: unknown; planHash?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const project = typeof body.project === "string" ? body.project.trim() : "";
  if (!PROJECT_RE.test(project) || body.confirm !== "yes") {
    return NextResponse.json({ error: "A valid project name and explicit confirmation are required." }, { status: 400, headers: { "cache-control": "no-store" } });
  }

  // Re-derive the plan NOW; it must still be supported and mutation-allowed.
  const derived = await projectPlan(project);
  if (!derived.available) {
    return NextResponse.json({ error: derived.reason }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  if (derived.pipelineOwned) {
    await recordAudit({
      actor, sourceIp: guard.sourceIp, kind: "update", action: "project-update",
      targetName: project, targetId: project, result: "rejected", durationMs: 0,
      error: "pipeline-owned project",
    }).catch(() => {});
    return NextResponse.json({ error: "Managed by external deployment pipeline — dashboard never mutates this project." }, { status: 403, headers: { "cache-control": "no-store" } });
  }
  if (!derived.plan.supported || !derived.plan.mutationAllowed) {
    return NextResponse.json(
      { error: derived.plan.unsupportedReason ?? "Project plan does not allow mutation (blocked or high-risk members, or rollback not ready).", plan: derived.plan },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  // Plan drift guard: the caller must have seen THIS plan.
  if (typeof body.planHash === "string" && body.planHash.length > 0 && body.planHash !== derived.plan.planHash) {
    return NextResponse.json(
      { error: "Update plan changed since it was shown — review the new plan and retry.", plan: derived.plan },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }

  const helper = await getHelperStatus().catch(() => null);
  if (helper?.reachable && isUpdatePhaseActive(helper.phase)) {
    return NextResponse.json({ error: `Update already running (phase ${helper.phase}).` }, { status: 409, headers: { "cache-control": "no-store" } });
  }
  const existingJob = await getProjectJob(project).catch(() => null);
  if (existingJob && !existingJob.finishedAt && existingJob.startedAt) {
    return NextResponse.json({ error: "A project update for this project is already running." }, { status: 409, headers: { "cache-control": "no-store" } });
  }

  const startedAt = Date.now();
  const result = await requestProjectUpdate(project);

  await recordAudit({
    actor, sourceIp: guard.sourceIp, kind: "update", action: "project-update",
    targetName: project, targetId: derived.plan.planHash,
    result: result.accepted ? "success" : "rejected",
    durationMs: Date.now() - startedAt,
    ...(result.reason && !result.accepted ? { error: result.reason } : {}),
  }).catch(() => {});

  if (!result.accepted) {
    return NextResponse.json({ error: result.reason ?? "Project update rejected." }, { status: result.status, headers: { "cache-control": "no-store" } });
  }

  // Outcome history is reconciled by the project-update status poll once
  // the machine settles — never pre-recorded here (a request is not an
  // outcome).

  return NextResponse.json(
    { accepted: true, project, phase: "requested", planHash: derived.plan.planHash, order: derived.plan.order.map((step) => step.service) },
    { status: 202, headers: { "cache-control": "no-store" } },
  );
}
