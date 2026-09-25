import { NextResponse } from "next/server";
import { getNetwork } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const section = await getNetwork();
  return NextResponse.json(section, {
    headers: { "cache-control": "no-store" },
  });
}
