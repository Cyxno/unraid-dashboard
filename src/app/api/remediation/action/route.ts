import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { executeRemediationAction } from "@/server/remediation/execute";
import { ensureOperationsState } from "@/server/remediation/operations";
import { unraidDemoActive } from "@/server/unraid/service";
import type { RemediationResult } from "@/lib/api-types";

export const dynamic = "force-dynamic";

/**
 * Single remediation entry point (v1.7.0). The action id MUST be offered
 * by the canonical catalog for the referenced incident; diagnostics are
 * read-only, guarded actions re-check preconditions on live state and
 * never return success without an observed effect.
 *
 * Demo mode: all mutations (guarded actions) are refused — runbooks and
 * action previews remain readable.
 */

interface RemediationRequestBody {
  incidentId?: string;
  actionId?: string;
  requestId?: string;
}

export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;

  let body: RemediationRequestBody;
  try {
    body = (await request.json()) as RemediationRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const incidentId = typeof body.incidentId === "string" ? body.incidentId.slice(0, 300) : "";
  const actionId = typeof body.actionId === "string" ? body.actionId.slice(0, 120) : "";
  const requestId = typeof body.requestId === "string" ? body.requestId.slice(0, 120) : undefined;
  if (!incidentId || !actionId) {
    return NextResponse.json({ error: "incidentId and actionId are required." }, { status: 400 });
  }

  await ensureOperationsState();
  const result = await executeRemediationAction({
    incidentId,
    actionId,
    actor: guard.identity.user ?? "local",
    sourceIp: guard.sourceIp,
    requestId,
  });

  // Demo contract: guarded operations never execute. Diagnostics are
  // read-only over Beacon's own state and stay available.
  if (unraidDemoActive()) {
    const response: RemediationResult = {
      ok: false,
      state: "rejected",
      message: "Demo mode: guarded actions are disabled.",
      operation: null,
    };
    return NextResponse.json(response, { status: 403, headers: { "cache-control": "no-store" } });
  }

  const httpStatus = result.ok ? 200 : result.state === "blocked" ? 409 : result.state === "rejected" ? 429 : 502;
  return NextResponse.json(result, { status: httpStatus, headers: { "cache-control": "no-store" } });
}
