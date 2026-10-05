import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { pushConfigured } from "@/server/notifications/push";
import { loadStateFromDisk } from "@/server/notifications/store";
import { startNotificationLoop } from "@/server/notifications";

export const dynamic = "force-dynamic";

/** Notification capability + current preferences + subscribed devices. */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;

  startNotificationLoop();
  const state = await loadStateFromDisk();
  const push = pushConfigured();

  return NextResponse.json(
    {
      push: { configured: push.configured, publicKey: push.publicKey },
      preferences: state.preferences,
      subscriptions: state.subscriptions.map((entry) => ({
        label: entry.label,
        endpointTail: entry.endpoint.slice(-12),
        createdAt: entry.createdAt,
        lastSuccessAt: entry.lastSuccessAt,
        lastFailureAt: entry.lastFailureAt,
        enabled: entry.enabled,
      })),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
