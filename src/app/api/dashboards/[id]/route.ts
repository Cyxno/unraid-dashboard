import { NextResponse, type NextRequest } from "next/server";
import { guardRead, guardWrite, type GuardResult } from "@/server/auth/guard";
import {
  deleteDashboard,
  DashboardError,
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
  if (!dashboard) {
    return NextResponse.json(
      { error: "Dashboard not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
  // View for everyone, edit for the owner (or everyone in trusted-LAN mode).
  const canEdit =
    guard.identity.mode === "disabled" ||
    (guard.identity.mode === "proxy" &&
      Boolean(guard.identity.user) &&
      dashboard.owner === guard.identity.user);
  return NextResponse.json(
    { dashboard, identity: guard.identity, canEdit },
    { headers: { "cache-control": "no-store" } },
  );
}

interface DashboardBody {
  name?: unknown;
  widgets?: unknown;
  preferences?: unknown;
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
  const guard = guardWrite(request);
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
    const dashboard = await updateDashboard(
      id,
      { name: String(body.name ?? ""), widgets: body.widgets, preferences: body.preferences },
      guard.identity,
    );
    return { dashboardName: dashboard.name, payload: { dashboard } };
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
