import { NextResponse, type NextRequest } from "next/server";
import { guardRead, guardWrite, guardDelete, type GuardResult } from "@/server/auth/guard";
import {
  canView,
  deleteDashboard,
  DashboardError,
  forkDashboard,
  getDashboard,
  updateDashboard,
} from "@/server/dashboards/store";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { recordAudit } from "@/server/actions/audit";

export const dynamic = "force-dynamic";

const ID_PATTERN = /^[a-z0-9]{12}$/;

/** Single dashboard fetch. Ids are format-checked before storage access. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const { id } = await params;
  if (!ID_PATTERN.test(id)) {
    return NextResponse.json(
      { error: "Invalid dashboard id." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const dashboard = await getDashboard(id);
  // Private dashboards of other users read as "not found" — no existence leak.
  if (!dashboard || !canView(dashboard, guard.identity)) {
    return NextResponse.json(
      { error: "Dashboard not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  // View for viewers; edit per the access model (owner, editors, LAN).
  const { canMutate } = await import("@/server/dashboards/store");
  const canEdit = canMutate(dashboard, guard.identity);
  return NextResponse.json(
    { dashboard, identity: guard.identity, canEdit },
    { headers: { "cache-control": "no-store" } },
  );
}

interface DashboardBody {
  name?: unknown;
  widgets?: unknown;
  preferences?: unknown;
  access?: unknown;
}

/** Shared mutation path: id check → guard → rate limit → audit → JSON. */
async function guardedMutation(
  request: NextRequest,
  id: string,
  action: "update" | "delete",
  run: (body: DashboardBody, identity: GuardResult<undefined> & { ok: true }) => Promise<{ dashboardName: string; payload: unknown }>,
): Promise<NextResponse> {
  if (!ID_PATTERN.test(id)) {
    return NextResponse.json(
      { error: "Invalid dashboard id." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  // PUT (JSON body) uses the POST-form guard; DELETE uses the DELETE-form
  // guard — both enforce auth + same-origin CSRF.
  const guard = action === "update" ? guardWrite(request) : guardDelete(request);
  if (!guard.ok) return guard.response;

  const actor = guard.identity.user ?? "lan";
  const rate = checkWriteRate(`${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many dashboard writes — slow down." },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": String(Math.ceil((rate.retryAfterMs ?? 60_000) / 1000)) } },
    );
  }

  let body: DashboardBody = {};
  if (action === "update") {
    try {
      body = (await request.json()) as DashboardBody;
    } catch {
      return NextResponse.json(
        { error: "Malformed JSON body." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
  }

  const startedAt = Date.now();
  try {
    const { dashboardName, payload } = await run(body, guard);
    await recordAudit({
      actor,
      sourceIp: guard.sourceIp,
      kind: "dashboard",
      action,
      targetName: dashboardName,
      targetId: id,
      result: "success",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof DashboardError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
    console.error(`[api/dashboards/${id}] ${action} failed:`, error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Dashboard storage failure." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return guardedMutation(request, id, "update", async (body, guard) => {
    const existing = await getDashboard(id);
    const dashboard = await updateDashboard(
      id,
      {
        name: String(body.name ?? ""),
        widgets: body.widgets,
        preferences: body.preferences,
        access: body.access,
      },
      guard.identity,
    );
    const accessChanged =
      existing &&
      JSON.stringify(existing.access) !== JSON.stringify(dashboard.access);
    return {
      dashboardName: dashboard.name,
      accessChanged: Boolean(accessChanged),
      payload: { dashboard },
    };
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return guardedMutation(request, id, "delete", async (_body, guard) => {
    const existing = await getDashboard(id);
    await deleteDashboard(id, guard.identity);
    return { dashboardName: existing?.name ?? id, payload: { deleted: true } };
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!ID_PATTERN.test(id)) {
    return NextResponse.json(
      { error: "Invalid dashboard id." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "lan";
  const rate = checkWriteRate(`fork:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many dashboard writes — slow down." },
      { status: 429, headers: { "cache-control": "no-store" } },
    );
  }
  const startedAt = Date.now();
  try {
    const fork = await forkDashboard(id, guard.identity);
    await recordAudit({
      actor,
      sourceIp: guard.sourceIp,
      kind: "dashboard",
      action: "fork",
      targetName: fork.name,
      targetId: `${id} → ${fork.id}`,
      result: "success",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(
      { dashboard: fork },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof DashboardError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: "Dashboard storage failure." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
