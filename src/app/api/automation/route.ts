import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getAutomationStatus } from "@/server/automation/status";
import { automationCapabilityContext } from "@/server/automation/capabilities";

export const dynamic = "force-dynamic";

/**
 * Automation status (v0.8.0): policy verdicts, queue, cooldowns, events,
 * project registry. Read-only; no credential material.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const [status, capabilityContext] = await Promise.all([
    getAutomationStatus(),
    automationCapabilityContext(),
  ]);
  // v0.9.11: normalized workflow eligibility (never stale — computed per
  // request from live helper health + the action capability model).
  return NextResponse.json({ ...status, capabilityContext }, { headers: { "cache-control": "no-store" } });
}
