import { NextResponse, type NextRequest } from "next/server";

/**
 * Page-level access control (API routes guard themselves in their
 * handlers via guardRead/guardWrite).
 *
 * AUTH_MODE=proxy hybrid trust (v0.7.6 restore):
 * - Valid proxy secret → Authelia-authenticated request; requires the
 *   identity header (NPM always injects both, overwriting client values).
 * - Secret present but WRONG → denied (401): never downgrade a bad
 *   proxy request to the trusted-local fallback.
 * - NO secret header at all → direct trusted-network access. Port 8090
 *   is firewall-restricted to LAN/Tailscale/localhost/Docker bridges,
 *   so such requests are the trusted local actor ("trusted-local").
 *   Client-supplied identity headers are IGNORED in this state — the
 *   fixed identity makes privilege spoofing from the LAN impossible.
 * Untrusted sources never reach the port (DASH8090 firewall chain).
 */
export function middleware(request: NextRequest) {
  const mode = (process.env.AUTH_MODE ?? "disabled").toLowerCase();
  if (mode !== "proxy") {
    return NextResponse.next();
  }
  const secret = process.env.AUTH_PROXY_SECRET;
  const secretHeaderName = process.env.AUTH_PROXY_SECRET_HEADER ?? "X-Dashboard-Auth-Token";
  const headerName = process.env.AUTH_HEADER ?? "X-Forwarded-User";

  const suppliedSecret = request.headers.get(secretHeaderName);

  // Wrong secret: deny — do not fall back to trusted-local.
  if (suppliedSecret !== null && suppliedSecret !== secret) {
    return new NextResponse(
      "Unauthorized — invalid proxy credentials.",
      { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  // No secret: firewall-backed direct trusted access.
  if (suppliedSecret === null) {
    return NextResponse.next();
  }

  // Valid secret: require the proxy-injected identity.
  const identity = request.headers.get(headerName);
  if (!identity || identity.trim().length === 0) {
    return new NextResponse(
      "Unauthorized — missing proxy identity.",
      { status: 401, headers: { "content-type": "text/plain; charset=utf-8" } },
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
