import { NextResponse } from "next/server";
import { sessionCookieName, localAuthState } from "@/server/auth/local";

export const dynamic = "force-dynamic";

/** Local-auth logout: clears the session cookie. Generic and stateless. */
export async function POST() {
  const local = localAuthState();
  if (!local.enabled) {
    return NextResponse.json({ error: "Local login is not enabled." }, { status: 404 });
  }
  const response = NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  response.cookies.set(sessionCookieName, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
