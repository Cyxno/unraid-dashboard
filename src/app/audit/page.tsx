"use client";

import { useState } from "react";
import { ClipboardList, FileWarning } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
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

/**
 * Audit trail: every write action attempted through the dashboard.
 * Read-only; entries contain no credential material by construction.
 */
export default function AuditPage() {
  const [limit, setLimit] = useState(100);
  const audit = usePoll<AuditLogPayload>(`/api/audit?limit=${limit}`, 30_000);
  const entries = audit.data?.entries ?? [];

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
          </div>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="size-4 text-muted-foreground" aria-hidden="true" />
            Entries
            {audit.data && (
              <Badge variant="muted" className="text-[10px]">
                {audit.data.total}
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
              lifecycle action is attempted from the dashboard.
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
                  {entries.map((entry) => (
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
