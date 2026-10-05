import { NextResponse, type NextRequest } from "next/server";
import { ensureSetupToken, claimSetup, SetupError } from "@/server/setup";
import { startNotificationLoop } from "@/server/notifications";

export const dynamic = "force-dynamic";

/**
 * One-shot setup claim. Requires the setup token from
 * /app/data/setup-token.txt (0600, host-generated). Rate limited per
 * source IP; after a successful claim every further call returns 409.
 */
export async function POST(request: NextRequest) {
  startNotificationLoop();
  await ensureSetupToken();
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  try {
    await claimSetup({
      token: String(body.token ?? ""),
      unraidUrl: String(body.unraidUrl ?? ""),
      unraidApiKey: String(body.unraidApiKey ?? ""),
      prometheusUrl: body.prometheusUrl ? String(body.prometheusUrl) : undefined,
      securityMode: body.securityMode === "local" ? "local" : "trusted",
      localUsername: body.localUsername ? String(body.localUsername) : undefined,
      localPassword: body.localPassword ? String(body.localPassword) : undefined,
    });
    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof SetupError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json({ error: "Setup failed." }, { status: 500 });
  }
}
