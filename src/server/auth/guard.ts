import { NextResponse, type NextRequest } from "next/server";
import { checkSameOrigin, resolveAuth, clientIpFrom } from "@/server/auth/auth";
import type { AuthIdentity } from "@/lib/api-types";

/**
 * Route-level access control helpers. Every API route calls one of these
 * before doing work.
 *
 * - guardRead: auth only (read endpoints).
 * - guardWrite: auth + same-origin (CSRF) + POST-only + JSON content type.
 *   Write endpoints are strictly more protected than read endpoints.
 */

export type GuardResult<TOk> =
  | { ok: true; identity: AuthIdentity; sourceIp: string; extra?: TOk }
  | { ok: false; response: NextResponse };

function reject(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status, headers: { "cache-control": "no-store" } });
}

export function guardRead(request: NextRequest): GuardResult<undefined> {
  const remoteAddress =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    null;
  const result = resolveAuth(request.headers, remoteAddress);
  if (!result.allowed) {
    return {
      ok: false,
      response: reject(result.reason ?? "Unauthorized", result.status ?? 401),
    };
  }
  return {
    ok: true,
    identity: result.identity,
    sourceIp: clientIpFrom(request.headers, remoteAddress),
  };
}

export function guardWrite(request: NextRequest): GuardResult<undefined> {
  const auth = guardRead(request);
  if (!auth.ok) return auth;

  // POST only — no GET mutations, ever.
  if (request.method !== "POST") {
    return { ok: false, response: reject("Method not allowed.", 405) };
  }

  // CSRF: same-origin enforcement.
  const originError = checkSameOrigin(request.headers, request.headers.get("host"));
  if (originError) {
    return { ok: false, response: reject(originError, 403) };
  }

  // Content type must be JSON (blocks form-based CSRF payloads).
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { ok: false, response: reject("Content-Type must be application/json.", 415) };
  }

  return auth;
}

/**
 * DELETE variant of guardWrite (v0.7): identical CSRF + auth posture,
 * but for DELETE requests (no body). Used by resource-removal endpoints;
 * GET/POST mutations remain the only other write forms.
 */
export function guardDelete(request: NextRequest): GuardResult<undefined> {
  const auth = guardRead(request);
  if (!auth.ok) return auth;

  if (request.method !== "DELETE") {
    return { ok: false, response: reject("Method not allowed.", 405) };
  }

  const originError = checkSameOrigin(request.headers, request.headers.get("host"));
  if (originError) {
    return { ok: false, response: reject(originError, 403) };
  }

  return auth;
}

/** Parses and structurally validates an action request body. */
export async function parseActionBody(
  request: NextRequest,
): Promise<{ ok: true; body: { kind: "docker" | "vm" | "notification"; action: string; id: string; requestId: string | null } } | { ok: false; response: NextResponse }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: reject("Malformed JSON body.", 400) };
  }
  const body = raw as Record<string, unknown>;
  const kind = body.kind;
  const action = body.action;
  const id = body.id;

  if (kind !== "docker" && kind !== "vm" && kind !== "notification") {
    return { ok: false, response: reject("Invalid kind.", 400) };
  }
  if (typeof action !== "string" || !/^[a-z]+$/.test(action)) {
    return { ok: false, response: reject("Invalid action.", 400) };
  }
  if (typeof id !== "string" || id.length === 0 || id.length > 200) {
    return { ok: false, response: reject("Invalid target id.", 400) };
  }
  // Optional idempotency key (v0.7): opaque client token, bounded charset.
  let requestId: string | null = null;
  if (body.requestId !== undefined && body.requestId !== null) {
    if (typeof body.requestId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.requestId)) {
      return { ok: false, response: reject("Invalid requestId.", 400) };
    }
    requestId = body.requestId;
  }
  return { ok: true, body: { kind, action, id, requestId } };
}
