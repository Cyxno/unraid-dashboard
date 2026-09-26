import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { DashboardError, importDashboards } from "@/server/dashboards/store";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { recordAudit } from "@/server/actions/audit";

export const dynamic = "force-dynamic";

/**
 * Import shared dashboards from the export format (or any JSON with a
 * `dashboards` array of {name, layout?, preferences?}). Strictly
 * validated: unknown fields stripped, size-bounded, new ids generated,
 * ownership follows the requesting identity. Nothing is auto-uploaded —
 * import only happens on explicit user action.
 */
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

  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 512 * 1024) {
    return NextResponse.json(
      { error: "Import payload too large." },
      { status: 413, headers: { "cache-control": "no-store" } },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Malformed JSON body." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const startedAt = Date.now();
  try {
    const result = await importDashboards(raw, guard.identity);
    await recordAudit({
      actor,
      sourceIp: guard.sourceIp,
      kind: "dashboard",
      action: "import",
      targetName: `${result.imported.length} dashboard(s)`,
      targetId: result.imported.map((dashboard) => dashboard.id).join(",").slice(0, 200),
      result: "success",
      durationMs: Date.now() - startedAt,
    });
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof DashboardError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
    console.error("[api/dashboards/import] failed:", error instanceof Error ? error.message : error);
    return NextResponse.json(
      { error: "Dashboard storage failure." },
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  }
}
