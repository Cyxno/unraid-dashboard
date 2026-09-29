import { NextResponse } from "next/server";
import { guardAgentRequest, agentCounters, noteAgentRequest, AGENT_API_VERSION, type AgentErrorCode } from "@/server/agent/auth";
import { envelope, type Freshness } from "@/server/agent/snapshot";

/**
 * Shared helpers for the Agent API routes (v0.9.4). Every route:
 *   guardAgentRequest → structured errors → envelope(json).
 */

export type AgentEndpoint =
  | "summary"
  | "docker"
  | "issues"
  | "projects"
  | "storage"
  | "system"
  | "operations"
  | "events"
  | "capabilities"
  | "stream";

export function agentJsonOk(data: unknown): NextResponse {
  return NextResponse.json(envelope(data), { headers: { "cache-control": "no-store" } });
}

export function agentJsonError(status: number, code: AgentErrorCode, message: string): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** Authenticates + rate-limits; returns NextResponse on failure, null on ok. */
export function requireAgent(
  request: Request,
  endpoint: AgentEndpoint,
): NextResponse | null {
  const auth = guardAgentRequest(request, endpoint);
  if (auth.ok) {
    noteAgentRequest(endpoint);
    return null;
  }
  return agentJsonError(
    auth.httpStatus ?? 401,
    (auth.error?.error.code ?? "UNAUTHORIZED") as AgentErrorCode,
    auth.error?.error.message ?? "Unauthorized",
  );
}

export { agentCounters, AGENT_API_VERSION };

export function freshness(sampledAt: string | null, stale: boolean, source: string): Freshness {
  return {
    sampledAt,
    stale,
    ageSeconds: sampledAt ? Math.max(0, Math.round((Date.now() - Date.parse(sampledAt)) / 1000)) : null,
    source,
  };
}

/** Helper health from the automation status shape (dependency view). */
export function helperHealth(automation: { infrastructure: { helperHealthy: boolean | null } } | null): { configured: boolean; reachable: boolean | null } | null {
  return automation ? { configured: true, reachable: automation.infrastructure.helperHealthy } : null;
}
