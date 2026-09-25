import { NextResponse } from "next/server";
import { guardRead } from "@/server/auth/guard";
import type { NextRequest } from "next/server";
import { getNetwork } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const section = await getNetwork();
  return NextResponse.json(section, {
    headers: { "cache-control": "no-store" },
  });
}
