import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { loadState } from "@/server/notifications/store";
import { startNotificationLoop } from "@/server/notifications";

export const dynamic = "force-dynamic";

/** Recent notification history (newest first, capped). */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;

  startNotificationLoop();
  const state = loadState();
  const limit = Math.min(Number(request.nextUrl.searchParams.get("limit")) || 50, 250);
  return NextResponse.json(
    {
      events: [...state.history].reverse().slice(0, limit),
      active: Object.entries(state.active).map(([fingerprint, entry]) => ({
        fingerprint,
        severity: entry.severity,
        category: entry.category,
        title: entry.title,
        firstSeenAt: entry.firstSeenAt,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
