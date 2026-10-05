import { timingSafeEqual } from "node:crypto";
import { getEnvSafe } from "@/server/env";

/**
 * Agent API auth + rate limiting (v0.9.4).
 *
 * - Dedicated read-only bearer credential (AGENT_API_TOKEN), independent
 *   from UI sessions, proxy secret, update-helper token and action key.
 * - Constant-time comparison; token never logged or returned.
 * - Default: token REQUIRED. Trusted-local access only when the operator
 *   explicitly sets AGENT_API_TRUST_LOCAL=true.
 * - Separate machine-friendly rate limits (generous for polling).
 * - Lightweight counters for Diagnostics — no payloads, no tokens.
 */

export const AGENT_API_VERSION = "1";

export type AgentErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "DISABLED"
  | "INVALID_QUERY"
  | "NOT_FOUND"
  | "INTERNAL";

export interface AgentError {
  error: { code: AgentErrorCode; message: string };
}

export function agentError(code: AgentErrorCode, message: string): AgentError {
  return { error: { code, message } };
}

/* ---- rate limiting (in-memory, per source + kind) -------------------------- */

const RATE_LIMITS: Record<string, { perMinute: number }> = {
  summary: { perMinute: 120 },
  docker: { perMinute: 60 },
  issues: { perMinute: 60 },
  projects: { perMinute: 60 },
  storage: { perMinute: 60 },
  system: { perMinute: 60 },
  operations: { perMinute: 60 },
  events: { perMinute: 60 },
  capabilities: { perMinute: 30 },
  stream: { perMinute: 10 },
};

const countersStore = globalThis as unknown as {
  __agentCounters?: {
    requests: number;
    authFailures: number;
    rateLimitHits: number;
    lastRequestAt: string | null;
    lastRequestEndpoint: string | null;
    sseClients: number;
  };
};
const rateStore = globalThis as unknown as {
  __agentRate?: Map<string, { count: number; windowStart: number }>;
};

function rateMap(): Map<string, { count: number; windowStart: number }> {
  if (!rateStore.__agentRate) rateStore.__agentRate = new Map();
  return rateStore.__agentRate;
}

export function agentCounters(): {
  requests: number;
  authFailures: number;
  rateLimitHits: number;
  lastRequestAt: string | null;
  lastRequestEndpoint: string | null;
  sseClients: number;
} {
  if (!countersStore.__agentCounters) {
    countersStore.__agentCounters = {
      requests: 0,
      authFailures: 0,
      rateLimitHits: 0,
      lastRequestAt: null,
      lastRequestEndpoint: null,
      sseClients: 0,
    };
  }
  return countersStore.__agentCounters;
}

export function isAgentApiEnabled(): boolean {
  const env = getEnvSafe();
  return Boolean(env.AGENT_API_TOKEN) || env.AGENT_API_TRUST_LOCAL === true;
}

export function noteAgentRequest(endpoint: string): void {
  const counters = agentCounters();
  counters.requests += 1;
  counters.lastRequestAt = new Date().toISOString();
  counters.lastRequestEndpoint = endpoint;
}

export function noteAgentAuthFailure(): void {
  agentCounters().authFailures += 1;
}

export function noteAgentRateLimit(): void {
  agentCounters().rateLimitHits += 1;
}

export function setAgentSseClients(count: number): void {
  agentCounters().sseClients = count;
}

/** Fixed-window rate limit per source+endpoint. Returns false when limited. */
export function agentRateOk(source: string, endpoint: keyof typeof RATE_LIMITS): boolean {
  const map = rateMap();
  const key = `${source}:${endpoint}`;
  const now = Date.now();
  const windowMs = 60_000;
  const entry = map.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    map.set(key, { count: 1, windowStart: now });
    // Bound the map.
    if (map.size > 500) {
      for (const [key, entry] of map) {
        if (now - entry.windowStart >= windowMs) map.delete(key);
      }
    }
    return true;
  }
  entry.count += 1;
  return entry.count <= (RATE_LIMITS[endpoint]?.perMinute ?? 60);
}

/* ---- auth ------------------------------------------------------------------ */

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a comparison to keep timing shape.
    const buf = Buffer.from(a + b);
    timingSafeEqual(buf, buf);
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function isTrustedLocal(source: string): boolean {
  // Trusted = loopback or the firewall-protected LAN range the app already
  // serves directly. Matches the DASH8090 allowlist semantics loosely; the
  // firewall remains the real boundary.
  return (
    source === "127.0.0.1" ||
    source === "::1" ||
    source === "::ffff:127.0.0.1" ||
    source.startsWith("192.168.1.")
  );
}

export interface AgentAuthResult {
  ok: boolean;
  /** Error payload when !ok. */
  error?: AgentError;
  httpStatus?: number;
  /** How the request authenticated (for counters only, never returned). */
  via?: "token" | "trusted-local";
}

/**
 * Guards an Agent API request. Policy:
 * - AGENT_API_TOKEN unset AND AGENT_API_TRUST_LOCAL unset → API disabled.
 * - Valid Bearer token → ok.
 * - No token + trusted-local source + AGENT_API_TRUST_LOCAL=true → ok.
 * - Anything else → 401 UNAUTHORIZED.
 */
export function guardAgentRequest(
  request: Request,
  endpoint: keyof typeof RATE_LIMITS,
): AgentAuthResult {
  const env = getEnvSafe();
  const token = env.AGENT_API_TOKEN;
  const trustLocal = env.AGENT_API_TRUST_LOCAL === true;

  if (!token && !trustLocal) {
    noteAgentAuthFailure();
    return {
      ok: false,
      httpStatus: 403,
      error: agentError("DISABLED", "Agent API is disabled (no credential configured)."),
    };
  }

  const source = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const authHeader = request.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer (.+)$/);

  if (token && match && constantTimeEqual(match[1] as string, token)) {
    if (!agentRateOk(source, endpoint)) {
      noteAgentRateLimit();
      return {
        ok: false,
        httpStatus: 429,
        error: agentError("RATE_LIMITED", "Agent API rate limit exceeded for this endpoint."),
      };
    }
    noteAgentRequest(endpoint);
    return { ok: true, via: "token" };
  }

  if (!token && trustLocal && isTrustedLocal(source)) {
    if (!agentRateOk(source, endpoint)) {
      noteAgentRateLimit();
      return {
        ok: false,
        httpStatus: 429,
        error: agentError("RATE_LIMITED", "Agent API rate limit exceeded for this endpoint."),
      };
    }
    noteAgentRequest(endpoint);
    return { ok: true, via: "trusted-local" };
  }

  noteAgentAuthFailure();
  return {
    ok: false,
    httpStatus: 401,
    error: agentError("UNAUTHORIZED", "Agent API token invalid or missing."),
  };
}

/** Token rotation: accept either the current or the next token. */
export function guardAgentRequestWithRotation(
  request: Request,
  endpoint: keyof typeof RATE_LIMITS,
  nextToken: string | null,
): AgentAuthResult {
  const authHeader = request.headers.get("authorization") ?? "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (match && nextToken && constantTimeEqual(match[1] as string, nextToken)) {
    if (!agentRateOk("rotated:" + (request.headers.get("x-forwarded-for") ?? "?"), endpoint)) {
      noteAgentRateLimit();
      return {
        ok: false,
        httpStatus: 429,
        error: agentError("RATE_LIMITED", "Agent API rate limit exceeded for this endpoint."),
      };
    }
    noteAgentRequest(endpoint);
    return { ok: true, via: "token" };
  }
  return guardAgentRequest(request, endpoint);
}
