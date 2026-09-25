import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Container healthcheck. Only verifies the dashboard process itself is
 * serving; it deliberately does NOT probe Unraid, so a restart loop is not
 * triggered when the Unraid API is briefly unreachable.
 */
export async function GET() {
  return NextResponse.json({ status: "ok", timestamp: new Date().toISOString() });
}
