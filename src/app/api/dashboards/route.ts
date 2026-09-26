import { NextResponse, type NextRequest } from "next/server";
import { guardRead, guardWrite } from "@/server/auth/guard";
import {
  createDashboard,
  DashboardError,
  listDashboards,
} from "@/server/dashboards/store";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { recordAudit } from "@/server/actions/audit";

export const dynamic = "force-dynamic";

/** Shared dashboards visible to the requester (whole set; single instance). */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const { dashboards, invalid } = await listDashboards();
  return NextResponse.json(
    { dashboards, invalid, identity: guard.identity },
    { headers: { "cache-control": "no-store" } },
  );
}

interface DashboardBody {
  name?: unknown;
  widgets?: unknown;
  preferences?: unknown;
}

/** Creates a shared dashboard. Guarded (auth + CSRF + rate limit + audit). */
export async function POST(request: NextRequest) {
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

  let body: DashboardBody;
  try {
    body = (await request.json()) as DashboardBody;
  } catch {
    return NextResponse.json(
      { error: "Malformed JSON body." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const startedAt = Date.now();
  try {
    const dashboard = await createDashboard(
      {
        name: String(body.name ?? ""),
        widgets: body.widgets,
        preferences: body.preferences,
      },
      guard.identity,
    );
    await recordAudit({
      actor,
      sourceIp: guard.sourceIp,
      kind: "dashboard",
      action: "create",
      targetName: dashboard.name,
      targetId: dashboard.id,
      result: "success",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(
      { dashboard },
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof DashboardError) {
      await recordAudit({
        actor,
        sourceIp: guard.sourceIp,
        kind: "dashboard",
        action: "create",
        targetName: String(body.name ?? "").slice(0, 120),
        targetId: "n/a",
        result: "rejected",
        durationMs: Date.now() - startedAt,
        error,
      }).catch(() => {});
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
    console.error("[api/dashboards] create failed:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Dashboard storage failure." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
