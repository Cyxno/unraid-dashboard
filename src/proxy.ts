import { NextResponse, type NextRequest } from "next/server";

/**
 * Request gate (Next 16 `proxy`, nodejs runtime).
 *
 * Order of enforcement:
 * 1. Proxy mode (env AUTH_MODE=proxy): unchanged hybrid trust from v0.7.
 * 2. Setup: an unconfigured install redirects pages to /setup and only
 *    allows the setup + health APIs through (bootstrap lock).
 * 3. Local auth: when configured, every page and API requires a valid
 *    session cookie; /login and the login API are the only exceptions.
 * 4. Trusted mode (default): pass-through — Tailscale/LAN identity is
 *    the boundary, exactly as in all releases before v1.3.0.
 *
 * API routes additionally enforce their own guards (guardRead/guardWrite)
 * — this gate is the authentication layer, not a replacement for
 * route-level authorization.
 */

const PUBLIC_EXACT = new Set([
  "/api/health",
  "/api/auth/login",
  "/api/auth/status",
  "/sw.js",
  "/manifest.webmanifest",
  "/apple-touch-icon.png",
  "/login",
]);

const PUBLIC_PREFIXES = [
  "/icons/",
  "/favicon",
  "/_next/static",
  "/_next/image",
  "/api/setup",
];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isSetupPath(pathname: string): boolean {
  return pathname === "/setup" || pathname.startsWith("/setup/");
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // 1. Proxy mode (env-forced, unchanged from v0.7).
  const envMode = (process.env.AUTH_MODE ?? "").toLowerCase();
  if (envMode === "proxy") {
    return proxyModeGate(request);
  }

  // 2. Setup bootstrap (unconfigured installs only). Static assets pass
  //    so the wizard can render.
  try {
    const { setupState } = await import("@/server/config/runtime");
    if ((await setupState()) === "unconfigured") {
      if (isSetupPath(pathname) || isPublicPath(pathname) || pathname === "/api/version") {
        return NextResponse.next();
      }
      if (pathname.startsWith("/api/")) {
        return new NextResponse(
          JSON.stringify({ error: "Setup required.", setupRequired: true }),
          { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } },
        );
      }
      return NextResponse.redirect(new URL("/setup", request.url));
    }
  } catch {
    // Fail closed to configured: no wizard redirect (avoids locking out
    // existing installs on a transient config read failure).
  }

  // 3. Local auth mode: session cookie required for everything that is
  //    not public. The login page is the only exception among pages.
  try {
    const { resolveAuthMode } = await import("@/server/config/runtime");
    if ((await resolveAuthMode()).mode === "local") {
      if (pathname === "/login" || pathname === "/api/auth/login") {
        return NextResponse.next();
      }
      if (isPublicPath(pathname)) {
        return NextResponse.next();
      }
      const { verifyLocalSessionFromRequest } = await import("@/server/auth/local-session");
      if (!verifyLocalSessionFromRequest(request)) {
        if (pathname.startsWith("/api/")) {
          return new NextResponse(
            JSON.stringify({ error: "Authentication required.", authRequired: true }),
            { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } },
          );
        }
        return NextResponse.redirect(new URL("/login", request.url));
      }
    }
  } catch {
    // Config read failure in local mode → fail open to trusted behaviour
    // for this request (route-level guards still apply). A persistent
    // config failure surfaces in logs.
  }

  // 4. Trusted mode: pass-through.
  return NextResponse.next();
}

/** Proxy-mode gate: unchanged hybrid trust from v0.7.6. */
function proxyModeGate(request: NextRequest): NextResponse {
  const secret = process.env.AUTH_PROXY_SECRET;
  const secretHeaderName = process.env.AUTH_PROXY_SECRET_HEADER ?? "X-Dashboard-Auth-Token";
  const headerName = process.env.AUTH_HEADER ?? "X-Forwarded-User";

  const suppliedSecret = request.headers.get(secretHeaderName);
  if (suppliedSecret !== null && suppliedSecret !== secret) {
    return new NextResponse("Unauthorized — invalid proxy credentials.", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (suppliedSecret === null) {
    return NextResponse.next();
  }
  const identity = request.headers.get(headerName);
  if (!identity || identity.trim().length === 0) {
    return new NextResponse("Unauthorized — missing proxy identity.", {
      status: 401,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon|icons/|apple-touch-icon|manifest.webmanifest|sw.js).*)",
  ],
};
