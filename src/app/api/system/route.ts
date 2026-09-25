import { NextResponse } from "next/server";
import { getSystem } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const section = await getSystem();
  return NextResponse.json(section, {
    headers: { "cache-control": "no-store" },
  });
}
