import { NextResponse } from "next/server";
import { getStorage } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const section = await getStorage();
  return NextResponse.json(section, {
    headers: { "cache-control": "no-store" },
  });
}
