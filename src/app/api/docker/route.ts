import { NextResponse } from "next/server";
import { getDocker } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const section = await getDocker();
  return NextResponse.json(section, {
    headers: { "cache-control": "no-store" },
  });
}
