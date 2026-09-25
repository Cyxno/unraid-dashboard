import { NextResponse } from "next/server";
import { getOverviewSnapshot } from "@/server/unraid/overview";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const snapshot = await getOverviewSnapshot();
    return NextResponse.json(snapshot, {
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
