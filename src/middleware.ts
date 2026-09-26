import { NextResponse, type NextRequest } from "next/server";

/**
 * Page-level access control (API routes guard themselves in their
 * handlers via guardRead/guardWrite).
 *
 * AUTH_MODE=proxy: pages require BOTH the proxy-injected identity header
 * AND the proxy-injected shared secret (AUTH_PROXY_SECRET_HEADER).
 * Without the secret — i.e. any direct request, including forged
 * identity headers from the LAN — access is rejected. The API layer
 * performs the same check with a constant-time comparison; this page
 * gate is the fast first line. Fail-closed when the secret is unset.
 */
export function middleware(request: NextRequest) {
  const mode = (process.env.AUTH_MODE ?? "disabled").toLowerCase();
  if (mode !== "proxy") {
    return NextResponse.next();
  }
  const secret = process.env.AUTH_PROXY_SECRET;
  const secretHeaderName = process.env.AUTH_PROXY_SECRET_HEADER ?? "X-Dashboard-Auth-Token";
  const headerName = process.env.AUTH_HEADER ?? "X-Forwarded-User";

  if (!secret || request.headers.get(secretHeaderName) !== secret) {
    return new NextResponse(
      "Unauthorized — the dashboard is only reachable via the configured reverse proxy.",
      { status: 401, headers: { "content-type": "text/plain" } },
    );
  }
  const identity = request.headers.get(headerName);
  if (!identity || identity.trim().length === 0) {
    return new NextResponse(
      "Unauthorized — missing proxy identity.",
      { status: 401, headers: { "content-type": "text/plain" } },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/docker/:path*",
    "/storage",
    "/network",
    "/system",
    "/vms",
    "/notifications",
    "/logs",
    "/audit",
    "/settings",
    "/noc",
    "/dashboard/:path*",
  ],
};
