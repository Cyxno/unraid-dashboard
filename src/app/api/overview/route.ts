import { NextResponse, type NextRequest } from "next/server";
import { getOverview } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

const WINDOWS = new Set(["5m", "15m", "1h"]);

export async function GET(request: NextRequest) {
  try {
    const windowParam = request.nextUrl.searchParams.get("window") ?? "15m";
    const window = WINDOWS.has(windowParam)
      ? (windowParam as "5m" | "15m" | "1h")
      : "15m";
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
