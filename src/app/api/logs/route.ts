import { NextResponse } from "next/server";
import { getLogFiles } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const section = await getLogFiles();
  return NextResponse.json(section, {
    headers: { "cache-control": "no-store" },
  });
}
