import { NextResponse } from "next/server";
import { getConnectionStatus } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const status = await getConnectionStatus();
  return NextResponse.json(status, {
    headers: { "cache-control": "no-store" },
  });
}
