import { NextResponse, type NextRequest } from "next/server";
import { guardRead, guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { loadStateFromDisk, scheduleSave } from "@/server/notifications/store";
import { startNotificationLoop } from "@/server/notifications";

export const dynamic = "force-dynamic";

function labelFromUserAgent(request: NextRequest): string {
  const ua = request.headers.get("user-agent") ?? "";
  const match = ua.match(/\(([^)]+)\)/);
  const platform = match?.[1] ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser}${platform ? ` · ${platform.split(";")[0]}` : ""}`.slice(0, 60);
}

/** Registers (upserts) a push subscription for this browser/device. */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "lan";
  const rate = checkWriteRate("subscribe:" + actor + "@" + guard.sourceIp);
  if (!rate.allowed) {
    return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(Math.ceil((rate.retryAfterMs ?? 1000) / 1000)) } });
  }
  // Subscriptions are tiny JSON documents; refuse oversized bodies early.
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 16 * 1024) {
    return NextResponse.json({ error: "payload too large" }, { status: 413 });
  }

  const body = (await request.json().catch(() => null)) as
    | { endpoint?: string; keys?: { p256dh?: string; auth?: string }; label?: string }
    | null;
  const endpoint = body?.endpoint;
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;
  if (!endpoint || !endpoint.startsWith("https://") || !p256dh || !auth) {
    return NextResponse.json({ error: "invalid subscription" }, { status: 400 });
  }

  const state = await loadStateFromDisk();
  startNotificationLoop();
  const existing = state.subscriptions.find((entry) => entry.endpoint === endpoint);
  if (existing) {
    existing.keys = { p256dh, auth };
    existing.enabled = true;
    existing.label = body?.label?.slice(0, 60) || existing.label || labelFromUserAgent(request);
  } else {
    state.subscriptions.push({
      endpoint,
      keys: { p256dh, auth },
      label: body?.label?.slice(0, 60) || labelFromUserAgent(request),
      createdAt: new Date().toISOString(),
      lastSuccessAt: null,
      lastFailureAt: null,
      enabled: true,
    });
  }
  scheduleSave(0);
  return NextResponse.json({ ok: true, devices: state.subscriptions.length }, { headers: { "cache-control": "no-store" } });
}

/** Removes a subscription (explicit unsubscribe from this device). */
export async function DELETE(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  const body = (await request.json().catch(() => null)) as { endpoint?: string } | null;
  if (!body?.endpoint) return NextResponse.json({ error: "invalid endpoint" }, { status: 400 });

  const state = await loadStateFromDisk();
  state.subscriptions = state.subscriptions.filter((entry) => entry.endpoint !== body.endpoint);
  scheduleSave(0);
  return NextResponse.json({ ok: true, devices: state.subscriptions.length }, { headers: { "cache-control": "no-store" } });
}
