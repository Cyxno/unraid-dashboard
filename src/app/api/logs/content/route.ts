import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getLogFileContent } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const params = request.nextUrl.searchParams;
  const path = params.get("path");
  if (!path || !path.startsWith("/") || path.includes("..")) {
    return NextResponse.json(
      { error: "A valid absolute log path is required." },
      { status: 400 },
    );
  }
  const lines = Number(params.get("lines") ?? 200);
  const section = await getLogFileContent(
    path,
    Number.isFinite(lines) ? lines : 200,
  );
  return NextResponse.json(section, {
    headers: { "cache-control": "no-store" },
  });
}
