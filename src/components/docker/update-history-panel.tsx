"use client";

import { useCallback, useMemo, useState } from "react";
import { History, RefreshCw } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatDateTimeIso } from "@/lib/utils";

/**
 * Update history (v0.7.13): filterable by target, result and scope.
 * Mobile: stacked cards. Desktop: table. Entries never contain secret data.
 */

interface HistoryEntry {
  timestamp: string;
  actor: string;
  scope: "self" | "container" | "compose" | "project";
  target: string | null;
  adapter: string | null;
  from: string;
  to: string;
  result: "success" | "rolled-back" | "failed";
  rollbackPerformed: boolean;
  durationMs: number;
  error?: string;
}

type ResultFilter = "all" | "success" | "failed" | "rollback";
type ScopeFilter = "all" | "self" | "container" | "compose" | "project";
type SourceFilter = "all" | "auto" | "manual";

const RESULT_VARIANT = {
  success: "success",
  "rolled-back": "warning",
  failed: "destructive",
} as const;

function scopeLabel(entry: HistoryEntry): string {
  if (entry.scope === "self") return "dashboard";
  if (entry.scope === "project") return (entry.target ?? "project").replace(/^project:/, "");
  return entry.target ?? entry.scope;
}

export function UpdateHistoryPanel() {
  const history = usePoll<{ entries: HistoryEntry[]; selfEntries: HistoryEntry[] }>("/api/docker/update-history?limit=150", 60_000);
  const [targetQuery, setTargetQuery] = useState("");
  const [resultFilter, setResultFilter] = useState<ResultFilter>("all");
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const debouncedTarget = useDebouncedValue(targetQuery, 150);

  const all = useMemo(
    () => [...(history.data?.entries ?? []), ...(history.data?.selfEntries ?? [])],
    [history.data],
  );

  const filtered = useMemo(() => {
    const q = debouncedTarget.trim().toLowerCase();
    return all
      .filter((entry) => {
        if (scopeFilter !== "all" && entry.scope !== scopeFilter) return false;
        if (sourceFilter === "auto" && entry.actor !== "system:auto-update") return false;
        if (sourceFilter === "manual" && entry.actor === "system:auto-update") return false;
        if (resultFilter === "success" && entry.result !== "success") return false;
        if (resultFilter === "failed" && entry.result !== "failed") return false;
        if (resultFilter === "rollback" && !entry.rollbackPerformed) return false;
        if (q && !`${entry.target ?? ""} ${entry.to} ${entry.from} ${entry.actor}`.toLowerCase().includes(q)) return false;
        return true;
      })
      .slice(0, 100);
  }, [all, debouncedTarget, resultFilter, scopeFilter]);

  const exportCsv = useCallback(() => {
    const header = "timestamp,actor,scope,target,adapter,from,to,result,rollback,durationMs";
    const lines = filtered.map((entry) =>
      [
        entry.timestamp,
        entry.actor,
        entry.scope,
        entry.target ?? "",
        entry.adapter ?? "",
        entry.from,
        entry.to,
        entry.result,
        String(entry.rollbackPerformed),
        String(entry.durationMs),
      ]
        .map((value) => `"${String(value).replaceAll('"', '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `update-history-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  return (
    <Card className="mb-4">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4 text-muted-foreground" aria-hidden />
          Update history
          <Badge variant="secondary" className="text-[10px]">
            {filtered.length}
          </Badge>
        </CardTitle>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={exportCsv} disabled={filtered.length === 0} aria-label="Export CSV">
            CSV
          </Button>
          <Button variant="ghost" size="sm" onClick={history.refresh} disabled={history.loading} aria-label="Refresh history">
            <RefreshCw className={cn("size-4", history.loading && "animate-spin")} aria-hidden />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="mb-3 flex flex-col gap-2 md:flex-row md:flex-wrap">
          <label className="relative md:w-52">
            <span className="sr-only">Filter by container or project</span>
            <input
              value={targetQuery}
              onChange={(event) => setTargetQuery(event.target.value)}
              placeholder="Container / project / actor…"
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
            />
          </label>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Result filter">
            {(["all", "success", "failed", "rollback"] as const).map((value) => (
              <Button
                key={value}
                variant={resultFilter === value ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs capitalize"
                onClick={() => setResultFilter(value)}
              >
                {value}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Scope filter">
            {(["all", "self", "container", "compose", "project"] as const).map((value) => (
              <Button
                key={value}
                variant={scopeFilter === value ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs capitalize"
                onClick={() => setScopeFilter(value)}
              >
                {value}
              </Button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Source filter">
            {(["all", "auto", "manual"] as const).map((value) => (
              <Button
                key={value}
                variant={sourceFilter === value ? "default" : "outline"}
                size="sm"
                className="h-8 text-xs capitalize"
                onClick={() => setSourceFilter(value)}
              >
                {value}
              </Button>
            ))}
          </div>
        </div>

        {history.error && !history.data && <p className="text-sm text-destructive">{history.error}</p>}
        {!history.data && !history.error && (
          <div className="space-y-2" role="status" aria-label="Loading history">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}
        {history.data && filtered.length === 0 && (
          <p className="text-sm text-muted-foreground">No update history matches the filters.</p>
        )}

        {/* Desktop table */}
        {filtered.length > 0 && (
          <div className="hidden md:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-3 font-medium">When</th>
                  <th className="py-1.5 pr-3 font-medium">Target</th>
                  <th className="py-1.5 pr-3 font-medium">Change</th>
                  <th className="py-1.5 pr-3 font-medium">Result</th>
                  <th className="py-1.5 pr-3 font-medium">Actor</th>
                  <th className="py-1.5 font-medium">Adapter</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry, index) => (
                  <tr key={`${entry.timestamp}-${index}`} className="border-b last:border-0">
                    <td className="whitespace-nowrap py-1.5 pr-3 text-xs">{formatDateTimeIso(entry.timestamp)}</td>
                    <td className="max-w-48 truncate py-1.5 pr-3" title={entry.target ?? "dashboard"}>
                      {scopeLabel(entry)}
                    </td>
                    <td className="max-w-56 truncate py-1.5 pr-3 text-xs text-muted-foreground" title={`${entry.from} → ${entry.to}`}>
                      {entry.from.split("/").pop()} → {entry.to.split("/").pop()}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge variant={RESULT_VARIANT[entry.result]} className="text-[10px]">
                        {entry.rollbackPerformed ? "rolled back" : entry.result}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-3 text-xs">{entry.actor}</td>
                    <td className="py-1.5 text-xs text-muted-foreground">{entry.adapter ?? "helper"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Mobile cards */}
        {filtered.length > 0 && (
          <div className="space-y-2 md:hidden">
            {filtered.map((entry, index) => (
              <div key={`${entry.timestamp}-m-${index}`} className="rounded-lg border p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{scopeLabel(entry)}</span>
                  <Badge variant={RESULT_VARIANT[entry.result]} className="text-[10px]">
                    {entry.rollbackPerformed ? "rolled back" : entry.result}
                  </Badge>
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground" title={`${entry.from} → ${entry.to}`}>
                  {entry.from.split("/").pop()} → {entry.to.split("/").pop()}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatDateTimeIso(entry.timestamp)} · {entry.actor} · {entry.adapter ?? "helper"}
                </p>
                {entry.error && <p className="mt-1 break-words text-xs text-destructive">{entry.error}</p>}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
