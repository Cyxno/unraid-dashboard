"use client";

import { useState } from "react";
import { Copy, Download, FileJson, Stethoscope } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { LoadingPanel } from "@/components/dashboard/page-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatDateTimeIso } from "@/lib/utils";
import type { DiagnosticsPayload, SourceHealth, SupportBundlePayload } from "@/lib/api-types";

/**
 * Source Diagnostics (v1.5.0 Fase 23) + support bundle generator
 * (Fase 28). One row per canonical source: status, last success, age,
 * latency, safe error — plus the "health of health" confidence banner
 * (Fase 24) and the persistence self-check (Fase 25).
 */

const SOURCE_LABELS: Record<string, string> = {
  "unraid-api": "Unraid API",
  prometheus: "Prometheus",
  cadvisor: "cAdvisor",
  "node-exporter": "node-exporter",
  helper: "Helper",
  "docker-inventory": "Docker inventory",
  "web-push": "Web Push",
  persistence: "Persistence",
  "beacon-update": "Beacon update check",
};

const SOURCE_ORDER = Object.keys(SOURCE_LABELS);

function statusTone(status: SourceHealth["status"]): "success" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "healthy":
      return "success";
    case "degraded":
      return "secondary";
    case "stale":
      return "outline";
    case "unavailable":
      return "destructive";
  }
}

function ageLabel(ms: number | null): string {
  if (ms == null) return "never";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export function DiagnosticsSection() {
  const diagnostics = usePoll<DiagnosticsPayload>("/api/diagnostics", 15_000);
  const [bundle, setBundle] = useState<SupportBundlePayload | null>(null);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const diag = diagnostics.data;
  const sources = (diag?.sourceHealth ?? []).slice().sort(
    (a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source),
  );
  const confidence = diag?.confidence;
  const persistence = diag?.persistence;

  const generate = async () => {
    setBundleBusy(true);
    setBundleError(null);
    try {
      const response = await fetch("/api/support-bundle", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setBundle((await response.json()) as SupportBundlePayload);
    } catch (error) {
      setBundleError(error instanceof Error ? error.message : "generation failed");
    } finally {
      setBundleBusy(false);
    }
  };

  const copyBundle = async () => {
    if (!bundle) return;
    await navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadBundle = () => {
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `beacon-diagnostics-${bundle.generatedAt.slice(0, 19).replaceAll(":", "")}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Stethoscope className="size-4 text-muted-foreground" aria-hidden="true" />
          Source diagnostics
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-1 text-sm">
        {diagnostics.loading && !diag ? (
          <LoadingPanel rows={4} />
        ) : !diag ? (
          <p className="text-muted-foreground">Diagnostics unavailable.</p>
        ) : (
          <>
            {confidence && confidence.level !== "full" ? (
              <div
                className={cn(
                  "rounded-md border p-2.5 text-xs",
                  confidence.level === "blind"
                    ? "border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-400"
                    : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
                )}
                data-testid="confidence"
              >
                <p className="font-semibold">
                  Metrics confidence: {confidence.level}
                </p>
                <ul className="mt-1 list-inside list-disc">
                  {confidence.reasons.slice(0, 4).map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="overflow-x-auto">
              <table className="w-full text-xs" data-testid="source-health-table">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="py-1.5 pr-2 font-medium">Source</th>
                    <th className="py-1.5 pr-2 font-medium">Status</th>
                    <th className="py-1.5 pr-2 font-medium">Last success</th>
                    <th className="py-1.5 pr-2 font-medium">Age</th>
                    <th className="py-1.5 pr-2 font-medium">Latency</th>
                    <th className="py-1.5 font-medium">Last error</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((source) => (
                    <tr key={source.source} className="border-b border-border/40" data-testid={`source-${source.source}`}>
                      <td className="py-1.5 pr-2 font-medium">{SOURCE_LABELS[source.source] ?? source.source}</td>
                      <td className="py-1.5 pr-2">
                        <Badge variant={statusTone(source.status)}>{source.status}</Badge>
                      </td>
                      <td className="py-1.5 pr-2 text-muted-foreground">{formatDateTimeIso(source.lastSuccessAt)}</td>
                      <td className="py-1.5 pr-2 font-mono">{ageLabel(source.ageMs)}</td>
                      <td className="py-1.5 pr-2 font-mono">{source.latencyMs != null ? `${source.latencyMs}ms` : "—"}</td>
                      <td className="py-1.5 max-w-40 truncate text-red-600 dark:text-red-400" title={source.safeError ?? undefined}>
                        {source.safeError ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {persistence ? (
              <div className="rounded-md border border-border/50 p-2.5 text-xs" data-testid="persistence-health">
                <p className="font-medium">Persistence self-check</p>
                <p className="mt-1 text-muted-foreground">
                  data dir writable:{" "}
                  <span className={persistence.dataDirWritable === false ? "font-semibold text-red-600 dark:text-red-400" : ""}>
                    {persistence.dataDirWritable == null ? "unknown" : persistence.dataDirWritable ? "yes" : "NO"}
                  </span>
                  {" · "}last successful persist: {formatDateTimeIso(persistence.lastSuccessfulPersistAt)}
                </p>
                {persistence.dataDirWritable === false ? (
                  <p className="mt-1 font-medium text-red-600 dark:text-red-400">
                    Persistence looks ephemeral or broken — incident/notification history may be lost on container recreate.
                  </p>
                ) : null}
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button variant="outline" size="sm" onClick={generate} disabled={bundleBusy} data-testid="generate-bundle">
                <FileJson className="size-4" /> {bundleBusy ? "Generating…" : "Generate diagnostics"}
              </Button>
              {bundle ? (
                <>
                  <Button variant="outline" size="sm" onClick={copyBundle}>
                    <Copy className="size-4" /> {copied ? "Copied" : "Copy"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={downloadBundle}>
                    <Download className="size-4" /> Download
                  </Button>
                </>
              ) : null}
            </div>
            {bundleError ? <p className="text-xs text-red-600 dark:text-red-400">{bundleError}</p> : null}
            {bundle ? (
              <pre
                className="max-h-72 overflow-auto rounded-md border border-border/50 bg-muted/30 p-2.5 text-[11px] leading-relaxed"
                data-testid="bundle-output"
              >
                {JSON.stringify(bundle, null, 2)}
              </pre>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              Bundles are sanitized server-side: no API keys, tokens, push endpoints or cookies. Safe to attach to an issue.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
