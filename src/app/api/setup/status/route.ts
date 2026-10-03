import { NextResponse } from "next/server";
import { getSetupState, ensureSetupToken } from "@/server/setup";
import { startNotificationLoop } from "@/server/notifications";

export const dynamic = "force-dynamic";

/** Setup state probe: unconfigured/configured + token file presence. */
export async function GET() {
  startNotificationLoop();
  await ensureSetupToken();
  const { state, tokenPresent } = await getSetupState();
  return NextResponse.json(
    {
      state,
      tokenPresent,
      version: process.env.APP_VERSION_FALLBACK ?? "unknown",
    },
    { headers: { "cache-control": "no-store" } },
  );
}
