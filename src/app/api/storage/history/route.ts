import { NextResponse, type NextRequest } from "next/server";
import { getStorageHistoryPayload } from "@/server/metrics-service";
import { parseWindow } from "@/server/prometheus/windows";

export const dynamic = "force-dynamic";

/** Per-device + aggregate disk throughput/IOPS history. */
export async function GET(request: NextRequest) {
  const window = parseWindow(request.nextUrl.searchParams.get("window"), "1h");
  const payload = await getStorageHistoryPayload(window);
  return NextResponse.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
