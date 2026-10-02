import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { sendTestNotification, startNotificationLoop } from "@/server/notifications";

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
  const result = await sendTestNotification();
  return NextResponse.json(
    { ok: result.delivered === "pushed" || result.delivered === "in-app", delivery: result.delivered, detail: result.detail },
    { headers: { "cache-control": "no-store" } },
  );
}
