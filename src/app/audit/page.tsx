"use client";

import { useMemo, useState } from "react";
import { ClipboardList, Download, FileWarning, FileJson } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { PageHeader } from "@/components/dashboard/page-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatDateTimeIso } from "@/lib/utils";
import type { AuditLogPayload } from "@/lib/api-types";

const RESULT_VARIANT = {
  success: "success",
  rejected: "warning",
  "already-in-state": "secondary",
  "not-found": "warning",
  timeout: "destructive",
  failed: "destructive",
} as const;

type ResultFilter = "all" | "success" | "failed";
type SourceFilter = "all" | "dashboard action" | "dashboard config" | "update" | "notification action";

const KIND_SOURCE: Record<string, SourceFilter> = {
  docker: "dashboard action",
  vm: "dashboard action",
  dashboard: "dashboard config",
  update: "update",
  notification: "notification action",
};

/**
 * Audit trail v0.7: filterable (actor, target, source, result), bounded,
 * exportable (JSON/CSV of the currently filtered view). Entries contain
 * no credential material by construction.
 */
export default function AuditPage() {
  const [limit, setLimit] = useState(100);
  const [actorQuery, setActorQuery] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const debouncedActor = useDebouncedValue(actorQuery, 150);
  const debouncedTarget = useDebouncedValue(targetQuery, 150);

  const audit = usePoll<AuditLogPayload>(`/api/audit?limit=${limit}`, 30_000);
  const entries = audit.data?.entries ?? [];

  const filtered = useMemo(() => {
    const actor = debouncedActor.trim().toLowerCase();
    const target = debouncedTarget.trim().toLowerCase();
    return entries.filter((entry) => {
      if (actor && !entry.actor.toLowerCase().includes(actor)) return false;
      if (target && !entry.targetName.toLowerCase().includes(target)) return false;
      if (resultFilter === "success" && entry.result !== "success") return false;
      if (resultFilter === "failed" && ["success", "already-in-state"].includes(entry.result)) return false;
      if (sourceFilter !== "all" && KIND_SOURCE[entry.kind] !== sourceFilter) return false;
      return true;
    });
  }, [entries, debouncedActor, debouncedTarget, resultFilter, sourceFilter]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
    download(blob, "audit-export.json");
  };

  const exportCsv = () => {
    const header = "timestamp,actor,sourceIp,kind,action,targetName,targetId,result,durationMs,error";
    const lines = filtered.map((entry) =>
      [
        entry.timestamp,
        entry.actor,
        entry.sourceIp,
        entry.kind,
        entry.action,
        entry.targetName,
        entry.targetId,
        entry.result,
        String(entry.durationMs),
        entry.error ? `"${entry.error.replaceAll('"', '""')}"` : "",
      ].join(","),
    );
    download(new Blob([[header, ...lines].join("\n")], { type: "text/csv" }), "audit-export.csv");
  };

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Dashboard-triggered actions, newest first"
        actions={
          <div className="flex items-center gap-1">
            {[50, 100, 250].map((option) => (
              <Button
                key={option}
                size="sm"
                variant={limit === option ? "secondary" : "ghost"}
                aria-pressed={limit === option}
                onClick={() => setLimit(option)}
                className="h-7 px-2.5 text-xs"
              >
                {option}
              </Button>
            ))}
            <Button size="sm" variant="ghost" disabled={filtered.length === 0} onClick={exportJson} aria-label="Export filtered entries as JSON" className="h-7 px-2">
              <FileJson aria-hidden="true" />
            </Button>
            <Button size="sm" variant="ghost" disabled={filtered.length === 0} onClick={exportCsv} aria-label="Export filtered entries as CSV" className="h-7 px-2">
              <Download aria-hidden="true" />
            </Button>
          </div>
        }
      />

      {/* Filters (v0.7) */}
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
        <input
          value={actorQuery}
          onChange={(event) => setActorQuery(event.target.value)}
          placeholder="Filter by actor…"
          aria-label="Filter by actor"
          className="h-9 w-full rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-44"
        />
        <input
          value={targetQuery}
          onChange={(event) => setTargetQuery(event.target.value)}
          placeholder="Filter by target…"
          aria-label="Filter by target"
          className="h-9 w-full rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-52"
        />
        <div role="group" aria-label="Filter by result" className="flex items-center gap-1">
          {(["all", "success", "failed"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={resultFilter === option ? "secondary" : "ghost"}
              aria-pressed={resultFilter === option}
              onClick={() => setResultFilter(option)}
              className="h-8 px-2.5 text-xs"
            >
              {option}
            </Button>
          ))}
        </div>
        <div role="group" aria-label="Filter by source" className="flex items-center gap-1 overflow-x-auto pb-1 md:flex-wrap md:pb-0">
          {(["all", "dashboard action", "dashboard config", "update", "notification action"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={sourceFilter === option ? "secondary" : "ghost"}
              aria-pressed={sourceFilter === option}
              onClick={() => setSourceFilter(option)}
              className="h-8 shrink-0 whitespace-nowrap px-2.5 text-xs"
            >
              {option}
            </Button>
          ))}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="size-4 text-muted-foreground" aria-hidden="true" />
            Entries
            {audit.data && (
              <Badge variant="muted" className="text-[10px]">
                {filtered.length === entries.length ? audit.data.total : `${filtered.length}/${entries.length}`}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {audit.loading && !audit.data ? (
            <Skeleton className="h-64 w-full" />
          ) : entries.length === 0 ? (
            <p className="flex items-center justify-center gap-2 rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
              <FileWarning className="size-4" aria-hidden="true" />
              No actions recorded yet. Audit entries appear here whenever a
              lifecycle action, dashboard change or update is attempted.
            </p>
          ) : filtered.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No entries match the current filters.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-sm">
                <caption className="sr-only">Audit entries</caption>
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">Time</th>
                    <th scope="col" className="px-3 py-2 font-medium">Actor</th>
                    <th scope="col" className="px-3 py-2 font-medium">Action</th>
                    <th scope="col" className="px-3 py-2 font-medium">Target</th>
                    <th scope="col" className="px-3 py-2 font-medium">Result</th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((entry) => (
                    <tr key={entry.id} className="border-b last:border-0">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-xs text-muted-foreground">
                        {formatDateTimeIso(entry.timestamp)}
                      </td>
                      <td className="max-w-[140px] truncate px-3 py-2" title={entry.sourceIp}>
                        {entry.actor}
                      </td>
                      <td className="px-3 py-2">
                        <span className="font-medium">{entry.kind}/{entry.action}</span>
                      </td>
                      <td className="max-w-[180px] truncate px-3 py-2 font-mono text-xs" title={entry.targetName}>
                        {entry.targetName}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={RESULT_VARIANT[entry.result as keyof typeof RESULT_VARIANT] ?? "destructive"}>
                          {entry.result}
                        </Badge>
                        {entry.error && (
                          <span className={cn("ml-2 text-[11px] text-muted-foreground")} title={entry.error}>
                            {entry.error.slice(0, 60)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {entry.durationMs} ms
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {audit.data?.truncated && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  Showing the newest {entries.length} entries; older entries are in rotated files.
                </p>
              )}
            </div>
          )}
          <p className="mt-3 text-[11px] text-muted-foreground">
            Entries are stored locally on the server in append-only rotated JSONL
            (2 MiB per file, 4 rotated files). Only rejections, results and
            timing are recorded — never credentials.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
