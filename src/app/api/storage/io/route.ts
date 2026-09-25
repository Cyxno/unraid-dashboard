import { NextResponse } from "next/server";
import { guardRead } from "@/server/auth/guard";
import type { NextRequest } from "next/server";
import { getDiskIoSnapshot } from "@/server/metrics-service";

export const dynamic = "force-dynamic";

/** Instant per-device disk I/O (read/write bytes per sec, IOPS). */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const payload = await getDiskIoSnapshot();
  return NextResponse.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
