import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getOverview } from "@/server/unraid/service";
import { parseWindow } from "@/server/prometheus/windows";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  try {
    const window = parseWindow(request.nextUrl.searchParams.get("window"), "15m");
    const payload = await getOverview(window);
    return NextResponse.json(payload, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    console.error("[api/overview] failed:", error);
    return NextResponse.json(
      { error: "Failed to load overview data." },
      { status: 502 },
    );
  }
}
