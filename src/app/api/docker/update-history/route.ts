import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { readContainerHistory, readUpdateHistory, type UpdateScope } from "@/server/update/history";

export const dynamic = "force-dynamic";

/**
 * Container/project update history (v0.7.13), newest first, with filters:
 * target (container or "project:name"), result, scope. Read-only; contains
 * no secret data by construction (entries never carry env or digests
 * beyond image refs).
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const url = new URL(request.url);
  const target = url.searchParams.get("target");
  const result = url.searchParams.get("result");
  const scope = url.searchParams.get("scope");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "100") || 100, 200);

  const validResults = new Set(["success", "rolled-back", "failed"]);
  const validScopes = new Set<UpdateScope>(["self", "container", "compose", "project"]);

  const entries = (await readContainerHistory({
    ...(target ? { target } : {}),
    ...(result && validResults.has(result) ? { result: result as "success" | "rolled-back" | "failed" } : {}),
    ...(scope && validScopes.has(scope as UpdateScope) ? { scope: scope as UpdateScope } : {}),
  })).slice(0, limit);

  // Self-update entries for the same view (labeled scope "self").
  const self = scope === "self" || !scope ? (await readUpdateHistory()).slice(0, limit) : [];
  return NextResponse.json(
    {
      entries: entries.map((entry) => ({
        timestamp: entry.timestamp,
        actor: entry.actor,
        scope: entry.scope ?? "container",
        target: entry.target ?? null,
        adapter: entry.adapter ?? null,
        from: entry.fromVersion,
        to: entry.toVersion,
        result: entry.result,
        rollbackPerformed: entry.rollbackPerformed,
        durationMs: entry.durationMs,
        ...(entry.error ? { error: entry.error } : {}),
      })),
      selfEntries: scope === "self" || !scope
        ? self.map((entry) => ({
            timestamp: entry.timestamp,
            actor: entry.actor,
            scope: "self" as const,
            target: null,
            adapter: "helper",
            from: entry.fromVersion,
            to: entry.toVersion,
            result: entry.result,
            rollbackPerformed: entry.rollbackPerformed,
            durationMs: entry.durationMs,
            ...(entry.error ? { error: entry.error } : {}),
          }))
        : [],
    },
    { headers: { "cache-control": "no-store" } },
  );
}
