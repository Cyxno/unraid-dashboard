import { NextResponse, type NextRequest } from "next/server";

/**
 * Page-level access control (API routes guard themselves in their
 * handlers via guardRead/guardWrite).
 *
 * AUTH_MODE=proxy: pages require the proxy-injected identity header.
 * A request without it (i.e. not proxied) is rejected — direct access
 * to the dashboard port is only possible for operators who deliberately
 * bypass the proxy, which the documented trust model forbids.
 *
 * AUTH_MODE=disabled (default): this middleware is a no-op.
 */
export function middleware(request: NextRequest) {
  const mode = (process.env.AUTH_MODE ?? "disabled").toLowerCase();
  if (mode !== "proxy") {
    return NextResponse.next();
  }
  const headerName = process.env.AUTH_HEADER ?? "X-Forwarded-User";
  const identity = request.headers.get(headerName);
  if (!identity || identity.trim().length === 0) {
    return new NextResponse(
      "Unauthorized — the dashboard is only reachable via the configured reverse proxy.",
      { status: 401, headers: { "content-type": "text/plain" } },
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/docker/:path*", "/storage", "/network", "/system", "/vms", "/notifications", "/logs", "/audit", "/settings", "/noc"],
};
