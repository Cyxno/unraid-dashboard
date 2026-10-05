import { getEnv } from "@/server/env";
import { timingSafeEqual } from "node:crypto";
import type { AuthIdentity } from "@/lib/api-types";

/**
 * Access-control layer.
 *
 * Modes (AUTH_MODE):
 * - "disabled" (default): trusted-LAN behavior. Every request is treated
 *   as an anonymous local user. Nothing else changes.
 * - "proxy": requests must arrive through a trusted reverse proxy that
 *   injects the configured identity header. Requests that do NOT come
 *   from a trusted proxy IP are rejected even if they carry the header
 *   (prevents header spoofing from arbitrary clients).
 *
 * The dashboard never performs password auth and holds no user store.
 */

export interface AuthResult {
  /** Request may proceed. */
  allowed: boolean;
  identity: AuthIdentity;
  /** Present when not allowed. */
  reason?: string;
  /** HTTP status to respond with when not allowed. */
  status?: number;
}

/** True for loopback and RFC1918 private addresses. */
export function isPrivateIp(ip: string): boolean {
  if (ip === "::1" || ip === "127.0.0.1" || ip === "localhost") return true;
  if (ip.startsWith("::ffff:")) return isPrivateIp(ip.slice(7));
  const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false; // IPv6 non-mapped: not treated as private LAN
  const [a, b] = [Number(match[1]), Number(match[2])];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Best-effort client IP from proxy headers, then the socket peer. */
export function clientIpFrom(
  headers: Headers,
  remoteAddress: string | null | undefined,
): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const first = forwardedFor.split(",")[0]?.trim();
    if (first) return first;
  }
  return remoteAddress ?? "unknown";
}

/** Normalize an identity header value into a display user name. */
function normalizeUser(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
}

/**
 * Resolve the request's auth state. Pure function of env + headers:
 * no I/O, trivially testable.
 *
 * Trust model (v0.7.6 hybrid, documented in README/SECURITY.md):
 * - Secret header PRESENT and valid (NPM + Authelia path): the request
 *   is authenticated; identity comes from the proxy-injected
 *   AUTH_HEADER. Client-supplied identity headers are overwritten by
 *   NPM before they reach the app.
 * - Secret header PRESENT but wrong: DENIED (401) — a broken/misconfigured
 *   proxy request must never downgrade to the trusted-local fallback.
 * - Secret header ABSENT: direct trusted-network access. Port 8090 is
 *   firewall-restricted (DASH8090 chain) to LAN/Tailscale/localhost/
 *   Docker bridges, so reachability IS the trust boundary (firewall-
 *   backed, not a spoofable header bypass). Such requests get the FIXED
 *   identity "trusted-local"; client-supplied identity headers are
 *   ignored entirely, so LAN users cannot escalate to named identities.
 * - The dashboard never performs password auth and holds no user store.
 */
export function resolveAuth(
  headers: Headers,
  /** Present for API parity with the proxy path; proxy auth reads the header only. */
  _remoteAddress: string | null | undefined,
): AuthResult {
  const env = getEnv();

  if (env.AUTH_MODE === "disabled") {
    return {
      allowed: true,
      identity: { mode: "disabled", user: null },
    };
  }

  // Proxy mode. The shared secret distinguishes the Authelia path from
  // direct trusted-network access; reachability is enforced by firewall.
  const secretHeader = headers.get(env.AUTH_PROXY_SECRET_HEADER);

  if (secretHeader !== null) {
    // Secret present: wrong value → deny; valid value → proxy identity.
    if (!proxySecretProvided(env, secretHeader)) {
      return {
        allowed: false,
        identity: { mode: "proxy", user: null },
        reason: "Unauthorized — invalid proxy credentials.",
        status: 401,
      };
    }

    const user = normalizeUser(headers.get(env.AUTH_HEADER));
    if (!user) {
      return {
        allowed: false,
        identity: { mode: "proxy", user: null },
        reason: `Missing identity header (${env.AUTH_HEADER}).`,
        status: 401,
      };
    }

    const allowedUsers = env.AUTH_ALLOWED_USERS.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (allowedUsers.length > 0 && !allowedUsers.includes(user)) {
      return {
        allowed: false,
        identity: { mode: "proxy", user },
        reason: "User is not in the allowed list.",
        status: 403,
      };
    }

    return { allowed: true, identity: { mode: "proxy", user } };
  }

  // No secret header: direct trusted-network request. Firewall-backed.
  // Fixed identity — client-supplied identity headers are ignored.
  // Fail closed when no secret is configured at all: without it the NPM
  // path cannot exist and the trust model is undefined.
  if (!env.AUTH_PROXY_SECRET) {
    return {
      allowed: false,
      identity: { mode: "proxy", user: null },
      reason: "Direct access is not permitted — proxy secret is not configured.",
      status: 401,
    };
  }
  return {
    allowed: true,
    identity: { mode: "proxy", user: "trusted-local" },
  };
}

/** Constant-time shared-secret comparison; absent config never matches. */
function proxySecretProvided(
  env: { AUTH_PROXY_SECRET?: string; AUTH_PROXY_SECRET_HEADER: string },
  headerValue: string | null,
): boolean {
  const secret = env.AUTH_PROXY_SECRET;
  if (!secret) return false;
  if (!headerValue) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(headerValue);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** CIDR-aware match for IPv4; exact/loopback otherwise. */
export function ipMatches(ip: string, rule: string): boolean {
  if (rule === "*" || rule === ip) return true;
  if (rule === "private") return isPrivateIp(ip);
  const cidr = rule.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/);
  if (!cidr) return ip === rule;
  const ipParts = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipParts) return false;
  const base = cidr[1]!.split(".").map(Number);
  const bits = Number(cidr[2]);
  const toInt = (parts: number[]) =>
    ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ipParts.slice(1, 5).map(Number) as number[]) & mask) === (toInt(base) & mask);
}

/**
 * CSRF: write endpoints accept only same-origin requests. Returns null
 * when the origin is acceptable, or a rejection reason.
 *
 * Behind a reverse proxy with an external hostname (PUBLIC_BASE_URL),
 * that origin is accepted alongside the request's own Host header.
 */
export function checkSameOrigin(
  headers: Headers,
  expectedHost: string | null,
): string | null {
  const origin = headers.get("origin");
  // Same-origin fetches always include Origin for POST in modern browsers.
  if (!origin) {
    return "Missing Origin header.";
  }
  let originHost: string | null;
  try {
    originHost = new URL(origin).host;
  } catch {
    return "Malformed Origin header.";
  }
  const host = headers.get("host") ?? expectedHost;
  if (host && originHost === host) return null;
  try {
    const env = getEnv();
    if (env.PUBLIC_BASE_URL && originHost === new URL(env.PUBLIC_BASE_URL).host) {
      return null;
    }
  } catch {
    // env unavailable or malformed — fall through to rejection
  }
  return `Cross-origin request rejected (${originHost}).`;
}
