"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Search, ScrollText } from "lucide-react";
import { PAGE_INTERVAL_MS } from "@/lib/prefs";
import { PageHeader, LoadingPanel, EmptyPanel } from "@/components/dashboard/page-primitives";
import { SectionStatus } from "@/components/dashboard/section-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePoll } from "@/hooks/use-poll";
import { cn, formatDateTimeIso, formatBytes } from "@/lib/utils";
import type { LogContent, LogFileEntry, Section } from "@/lib/api-types";

const DEFAULT_LINES = 300;

export default function LogsPage() {
  const files = usePoll<Section<LogFileEntry[]>>(
    "/api/logs",
    PAGE_INTERVAL_MS.logs,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [lines, setLines] = useState(DEFAULT_LINES);
  const [search, setSearch] = useState("");
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const [content, setContent] = useState<Section<LogContent> | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState<string | null>(null);

  const loadContent = useCallback(async (path: string, lineCount: number) => {
    setContentLoading(true);
    setContentError(null);
    try {
      const response = await fetch(
        `/api/logs/content?path=${encodeURIComponent(path)}&lines=${lineCount}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setContent((await response.json()) as Section<LogContent>);
    } catch (error) {
      setContentError(error instanceof Error ? error.message : "Request failed");
    } finally {
      setContentLoading(false);
    }
  }, []);

  // Auto-select syslog once the file list arrives; explicit user selection
  // always wins. Defined as a plain value (no render-time state updates).
  const activePath =
    selected ??
    files.data?.data?.find((file) => file.path.endsWith("/syslog"))?.path ??
    files.data?.data?.[0]?.path ??
    null;

  const lastRequested = useRef<string | null>(null);
  useEffect(() => {
    if (!activePath) return;
    const requestKey = `${activePath}#${lines}`;
    if (lastRequested.current === requestKey) return;
    lastRequested.current = requestKey;
    void loadContent(activePath, lines);
  }, [activePath, lines, loadContent]);

  // Optional auto-refresh (10s) — pause stops both polling and scroll churn.
  useEffect(() => {
    if (!autoRefresh || !activePath) return;
    const timer = setInterval(() => void loadContent(activePath, lines), 10_000);
    return () => clearInterval(timer);
  }, [autoRefresh, activePath, lines, loadContent]);

  const filteredLines = (content?.data?.lines ?? []).filter((line) =>
    search.trim() ? line.toLowerCase().includes(search.trim().toLowerCase()) : true,
  );

  /** Conservative severity classification from the line's own text. */
  const severityOf = (line: string): "error" | "warn" | null => {
    if (/\b(err(or)?|critical|alert|fatal|panic)\b/i.test(line)) return "error";
    if (/\bwarn(ing)?\b/i.test(line)) return "warn";
    return null;
  };

  const copyLine = async (line: string) => {
    try {
      await navigator.clipboard.writeText(line);
      setCopied(line.slice(0, 40));
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard unavailable — silently ignore.
    }
  };

  const downloadSlice = () => {
    if (!content?.data) return;
    const blob = new Blob([content.data.lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${content.data.path.split("/").pop() ?? "log"}-tail.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <PageHeader
        title="Logs"
        description="Read-only system logs via the Unraid API"
        actions={
          <SectionStatus
            section={
              files.data ?? {
                status: "unavailable",
                data: null,
                fetchedAt: "",
                ageMs: 0,
              }
            }
          />
        }
      />

      <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
        {/* On phones the file list collapses to a compact block. */}
        <Card className="h-fit min-w-0">
          <CardHeader>
            <CardTitle className="text-sm">Log files</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {files.loading && !files.data ? (
              <LoadingPanel rows={5} />
            ) : files.data?.data ? (
              <ul className="max-h-44 space-y-0.5 overflow-y-auto lg:max-h-[60vh]">
                {files.data.data.map((file) => (
                  <li key={file.path}>
                    <Button
                      variant={selected === file.path ? "secondary" : "ghost"}
                      size="sm"
                      className="w-full justify-start gap-2 font-normal"
                      aria-pressed={selected === file.path}
                      onClick={() => {
                        setSelected(file.path);
                        void loadContent(file.path, lines);
                      }}
                    >
                      <FileText className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-left">{file.name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {formatBytes(file.sizeBytes, 0)}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Log list unavailable.</p>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="flex flex-wrap items-center gap-2">
              <ScrollText className="size-4 text-muted-foreground" aria-hidden="true" />
              {content?.data?.path ?? "Select a log file"}
              {content?.data?.totalLines != null && (
                <Badge variant="muted" className="text-[10px]">
                  {content.data.totalLines.toLocaleString()} lines
                </Badge>
              )}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <label className="relative">
                <span className="sr-only">Filter log lines</span>
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
                  aria-hidden="true"
                />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Filter…"
                  className="h-8 w-40 rounded-md border bg-card pl-8 pr-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <label className="flex items-center gap-1 text-xs text-muted-foreground">
                Tail
                <select
                  value={lines}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    setLines(next);
                    if (selected) void loadContent(selected, next);
                  }}
                  className="h-8 rounded-md border bg-card px-1.5 text-xs"
                >
                  {[100, 300, 1000].map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                size="sm"
                variant={autoRefresh ? "secondary" : "ghost"}
                aria-pressed={autoRefresh}
                className="h-8 px-2 text-xs"
                disabled={!selected}
                onClick={() => setAutoRefresh((value) => !value)}
                title="Reload the tail every 10 seconds"
              >
                {autoRefresh ? "Pause" : "Auto-refresh"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-xs"
                disabled={!selected || contentLoading}
                onClick={() => selected && void loadContent(selected, lines)}
              >
                Reload
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 px-2 text-xs"
                disabled={!content?.data}
                onClick={downloadSlice}
              >
                Download tail
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {contentLoading && !content ? (
              <LoadingPanel rows={10} />
            ) : contentError ? (
              <p
                role="alert"
                className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
              >
                Log read failed: {contentError}
              </p>
            ) : content?.data ? (
              <>
                <p className="mb-2 text-[11px] text-muted-foreground">
                  Showing lines {content.data.startLine ?? "?"}–
                  {(content.data.startLine ?? 0) + content.data.lines.length} of{" "}
                  {content.data.totalLines?.toLocaleString() ?? "?"} · fetched{" "}
                  {formatDateTimeIso(content.fetchedAt)}
                </p>
                {filteredLines.length === 0 ? (
                  <EmptyPanel
                    message={
                      search
                        ? "No lines match the filter."
                        : "This log file is empty."
                    }
                  />
                ) : (
                  <pre
                    className="max-h-[62vh] overflow-auto rounded-md bg-background p-3 font-mono text-xs leading-5"
                    aria-label="Log content"
                  >
                    {filteredLines.map((line, index) => {
                      const severity = severityOf(line);
                      return (
                        <button
                          key={`${index}-${line.slice(0, 12)}`}
                          type="button"
                          title="Click to copy this line"
                          onClick={() => void copyLine(line)}
                          className={cn(
                            "block w-full whitespace-pre-wrap break-all rounded text-left",
                            severity === "error" && "text-destructive",
                            severity === "warn" && "text-warning",
                            copied === line.slice(0, 40) && "bg-secondary",
                          )}
                        >
                          {line}
                        </button>
                      );
                    })}
                  </pre>
                )}
                {search && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    {filteredLines.length} of {content.data.lines.length} lines match.
                  </p>
                )}
              </>
            ) : (
              <EmptyPanel message="Select a log file to view its recent content." />
            )}
          </CardContent>
        </Card>
      </div>
      <p className="mt-4 text-[11px] text-muted-foreground">
        Logs are read through the Unraid API with the dashboard&apos;s read-only
        key — only files reported by the API can be opened, and output is capped
        at 1,000 lines.
      </p>
    </div>
  );
}
