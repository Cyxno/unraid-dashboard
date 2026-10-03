import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { verifyLocalLogin, newSessionPayload, signSession, sessionSecret, sessionCookieName, SESSION_MAX_AGE_SECONDS, localAuthState } from "@/server/auth/local";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { loadConfig } from "@/server/config/store";

export const dynamic = "force-dynamic";

/**
 * Local-auth login: validates credentials and sets an HttpOnly session
 * cookie. Rate limited per source IP; generic error only (no username
 * enumeration). Trusted and proxy modes never call this.
 */
export async function POST(request: NextRequest) {
  const actor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
  const rate = checkWriteRate(`login:${actor}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many attempts — try again later." },
      { status: 429, headers: { "retry-after": String(Math.ceil((rate.retryAfterMs ?? 1000) / 1000)) } },
    );
  }

  let body: { username?: string; password?: string };
  try {
    body = (await request.json()) as { username?: string; password?: string };
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  const config = loadConfig();
  if (config.security.mode !== "local" || !config.security.local) {
    return NextResponse.json({ error: "Local login is not enabled." }, { status: 404 });
  }

  const sessionSecret = config.security.sessionSecret;
  if (!sessionSecret || sessionSecret.length < 32) {
    return NextResponse.json({ error: "Session secret not configured." }, { status: 500 });
  }

  const result = verifyLocalLogin(body.username ?? "", body.password ?? "");
  if (!result.ok) {
    return NextResponse.json({ error: "Invalid username or password." }, { status: 401 });
  }

  const payload = newSessionPayload(result.username, config.security.sessionEpoch);
  const token = signSession(sessionSecret, payload);
  // Secure flag: set when the login arrived via HTTPS (proxy-injected
  // X-Forwarded-Proto or the direct request protocol).
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const secure = proto === "https";

  const response = NextResponse.json({ ok: true, username: result.username }, { headers: { "cache-control": "no-store" } });
  response.cookies.set(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}

/** Logout: clears the cookie. The session token itself expires on TTL or
 *  credential change (sessionEpoch bump). */
export async function DELETE(request: NextRequest) {
  const mode = localAuthState();
  if (!mode.enabled) {
    return NextResponse.json({ error: "Local login is not enabled." }, { status: 404 });
  }
  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  response.cookies.set(sessionCookieName, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
