import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { buildSupportBundleFull } from "@/server/incidents/bundle";

export const dynamic = "force-dynamic";

/**
 * Generate diagnostics (v1.5.0 Fase 28): a bounded, sanitized support
 * bundle. POST (not GET) because generation is an explicit action; the
 * payload passes the redactor before serialization and contains no
 * credentials, endpoints, cookies or environment values (Fase 29 tests
 * enforce this).
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const bundle = await buildSupportBundleFull();
  return NextResponse.json(bundle, { headers: { "cache-control": "no-store" } });
}
