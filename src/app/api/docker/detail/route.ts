import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getContainerDetail } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

/** Full detail for one container (read-only). */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const name = request.nextUrl.searchParams.get("name") ?? "";
  const detail = await getContainerDetail(name);
  return NextResponse.json(detail, { headers: { "cache-control": "no-store" } });
}
