import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getInterfacesHistoryPayload } from "@/server/metrics-service";
import { parseWindow } from "@/server/prometheus/windows";

export const dynamic = "force-dynamic";

/** Per-interface RX/TX history (physical-ish interfaces only). */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const window = parseWindow(request.nextUrl.searchParams.get("window"), "1h");
  const payload = await getInterfacesHistoryPayload(window);
  return NextResponse.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
