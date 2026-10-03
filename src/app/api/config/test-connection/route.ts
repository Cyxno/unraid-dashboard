import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { resolveUnraidUrl, resolvePrometheusUrl } from "@/server/config/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "lan";
  const rate = checkWriteRate(`conn-test:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }

  const key = request.nextUrl.searchParams.get("key") ?? "";
  if (key === "unraid") {
    const url = resolveUnraidUrl().value;
    if (!url) return NextResponse.json({ ok: false, detail: "Unraid API URL not configured." });
    try {
      const start = Date.now();
      const res = await fetch(`${url}/graphql`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "{ vars { version } }" }),
        signal: AbortSignal.timeout(5000),
      });
      return NextResponse.json({ ok: res.ok, detail: res.ok ? `Connected (${Date.now() - start} ms)` : `HTTP ${res.status}` });
    } catch (e) {
      return NextResponse.json({ ok: false, detail: e instanceof Error ? e.message : "Connection failed." });
    }
  }
  if (key === "prometheus") {
    const url = resolvePrometheusUrl().value;
    if (!url) return NextResponse.json({ ok: false, detail: "Prometheus URL not configured." });
    try {
      const start = Date.now();
      const res = await fetch(`${url}/-/healthy`, { signal: AbortSignal.timeout(5000) });
      return NextResponse.json({ ok: res.ok, detail: res.ok ? `Connected (${Date.now() - start} ms)` : `HTTP ${res.status}` });
    } catch (e) {
      return NextResponse.json({ ok: false, detail: e instanceof Error ? e.message : "Connection failed." });
    }
  }
  return NextResponse.json({ ok: false, detail: "Unknown integration." }, { status: 400 });
}
