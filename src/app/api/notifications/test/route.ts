import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { sendTestNotification, startNotificationLoop } from "@/server/notifications";
import { classifyTestPush } from "@/server/notifications/push";
import { loadStateFromDisk } from "@/server/notifications/store";

export const dynamic = "force-dynamic";

/**
 * Sends a real user-triggered test notification through every configured
 * delivery channel (web push + in-app). Guarded like every write and
 * rate-limited: this is the only way notifications can be created outside
 * the internal evaluation cycle — there is no generic "send" endpoint.
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "lan";
  const rate = checkWriteRate(`notify-test:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "rate limited", retryAfterMs: rate.retryAfterMs },
      { status: 429, headers: { "retry-after": String(Math.ceil((rate.retryAfterMs ?? 1000) / 1000)) } },
    );
  }

  startNotificationLoop();
  // Fase 11 (v1.3.19): every manual test carries a trace id so UI → engine →
  // provider → history can be correlated. Delivery semantics (Fase 12):
  // "pushed" means the PROVIDER accepted the message — that is not proof the
  // iPhone rendered a notification; the device-side trace is the acceptance.
  const state = await loadStateFromDisk();
  const traceId = `test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const subscribedDevices = state.subscriptions.filter((entry) => entry.enabled).length;
  // Fase 13 (v1.3.22): a "Send Web Push Test" with zero devices is NOT a
  // success — in-app SSE delivery must not be presented as Web Push.
  const precheck = classifyTestPush(subscribedDevices);
  if (!precheck.ok) {
    return NextResponse.json(
      {
        ok: false,
        delivery: precheck.delivery,
        reason: precheck.reason,
        detail: "No Web Push device is registered. This message was only delivered inside the open Beacon app.",
        traceId,
        subscribedDevices: 0,
        providerAccepted: false,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
  const result = await sendTestNotification();
  return NextResponse.json(
    {
      ok: result.delivered === "pushed" || result.delivered === "in-app",
      delivery: result.delivered,
      detail: result.detail,
      traceId,
      subscribedDevices,
      // provider_accepted implies delivery to the push service only.
      providerAccepted: result.delivered === "pushed",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
