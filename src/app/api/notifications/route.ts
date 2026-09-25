import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getNotificationList } from "@/server/unraid/service";

export const dynamic = "force-dynamic";

const IMPORTANCES = new Set(["INFO", "WARNING", "ALERT"]);

export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const params = request.nextUrl.searchParams;
  const type = params.get("type") === "ARCHIVE" ? "ARCHIVE" : "UNREAD";
  const importanceParam = params.get("importance") ?? undefined;
  const importance =
    importanceParam && IMPORTANCES.has(importanceParam)
      ? (importanceParam as "INFO" | "WARNING" | "ALERT")
      : undefined;
  const limit = Number(params.get("limit") ?? 50);
  const offset = Number(params.get("offset") ?? 0);
  const section = await getNotificationList({
    type,
    importance,
    limit: Number.isFinite(limit) ? limit : 50,
    offset: Number.isFinite(offset) ? Math.max(0, offset) : 0,
  });
  return NextResponse.json(section, {
    headers: { "cache-control": "no-store" },
  });
}
