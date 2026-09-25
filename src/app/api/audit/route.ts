import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { readAudit } from "@/server/actions/audit";

export const dynamic = "force-dynamic";

/** Audit trail (newest first). Authorized users only; no secrets. */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const limitParam = Number(request.nextUrl.searchParams.get("limit") ?? "100");
  const limit = Math.min(500, Math.max(10, Number.isFinite(limitParam) ? limitParam : 100));
  const payload = await readAudit(limit);
  return NextResponse.json(payload, { headers: { "cache-control": "no-store" } });
}
