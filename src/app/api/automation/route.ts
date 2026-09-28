import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getAutomationStatus } from "@/server/automation/status";

export const dynamic = "force-dynamic";

/**
 * Automation status (v0.8.0): policy verdicts, queue, cooldowns, events,
 * project registry. Read-only; no credential material.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const status = await getAutomationStatus();
  return NextResponse.json(status, { headers: { "cache-control": "no-store" } });
}
