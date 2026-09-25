import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { getContainerHistoryPayload } from "@/server/metrics-service";
import { parseWindow } from "@/server/prometheus/windows";

export const dynamic = "force-dynamic";

/**
 * Per-container CPU/memory history. The name is validated as a plain
 * Docker container name and interpolated server-side into a PromQL
 * string literal — the browser never sends PromQL itself.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const name = request.nextUrl.searchParams.get("name") ?? "";
  // Docker container names: [a-zA-Z0-9][a-zA-Z0-9_.-]* — reject anything else.
  const valid = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name);
  if (!valid) {
    return NextResponse.json(
      { error: "Invalid container name." },
      { status: 400 },
    );
  }
  const window = parseWindow(request.nextUrl.searchParams.get("window"), "1h");
  const payload = await getContainerHistoryPayload(name, window);
  return NextResponse.json(payload, {
    headers: { "cache-control": "no-store" },
  });
}
