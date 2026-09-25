import { NextResponse } from "next/server";
import { getVms } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const section = await getVms();
  return NextResponse.json(section, {
    headers: { "cache-control": "no-store" },
  });
}
