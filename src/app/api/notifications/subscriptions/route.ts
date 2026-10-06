import { NextResponse, type NextRequest } from "next/server";
import { guardDelete, guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { loadStateFromDisk, scheduleSave } from "@/server/notifications/store";
import { createHash } from "node:crypto";

/** v1.3.22: privacy-safe endpoint fingerprint (SHA-256, 16 hex). Mirrors
 *  the browser's WebCrypto computation so reconciliation never exposes the
 *  raw endpoint. */
function endpointFingerprint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex").slice(0, 16);
}
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
  const fingerprint = endpointFingerprint(endpoint);
  return NextResponse.json(
    { ok: true, registered: true, devices: state.subscriptions.length, endpointFingerprint: fingerprint },
    { headers: { "cache-control": "no-store" } },
  );
}

/** Removes a subscription (explicit unsubscribe from this device). */
export async function DELETE(request: NextRequest) {
  // guardDelete: identical CSRF posture as guardWrite but for DELETE —
  // guardWrite is POST-only and rejected every unsubscribe with 405.
  const guard = guardDelete(request);
  if (!guard.ok) return guard.response;

  const body = (await request.json().catch(() => null)) as { endpoint?: string; fingerprint?: string } | null;
  if (!body?.endpoint && !body?.fingerprint) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  const state = await loadStateFromDisk();
  const before = state.subscriptions.length;
  // v1.3.22: removal by endpoint OR by fingerprint (for the server-only
  // disable edge where the browser subscription no longer exists).
  state.subscriptions = state.subscriptions.filter((entry) => {
    if (body.endpoint && entry.endpoint === body.endpoint) return false;
    if (body.fingerprint) {
      const fp = createHash("sha256").update(entry.endpoint).digest("hex").slice(0, 16);
      if (fp === body.fingerprint) return false;
    }
    return true;
  });
  const removed = before - state.subscriptions.length;
  scheduleSave(0);
  return NextResponse.json({ ok: true, removed, devices: state.subscriptions.length }, { headers: { "cache-control": "no-store" } });
}
