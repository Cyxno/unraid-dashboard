"use client";

import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronRight, Eye, FlaskConical, RefreshCw } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { EmptyPanel, ErrorPanel, LoadingPanel, PageHeader } from "@/components/dashboard/page-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatDateTimeIso } from "@/lib/utils";
import type { IncidentsPayload, Incident } from "@/lib/api-types";

/**
 * Incident Center (v1.5.0 Fase 21): ACTIVE + RECENTLY RECOVERED. One row
 * per incident — severity, entity, duration, reason, source, freshness —
 * tap for the full evidence/timeline detail. Deliberately NOT a SOC
 * wallboard: calm hierarchy, mobile-first, no duplicated banners.
 */

const REFRESH_MS = 10_000;

const SEVERITY_STYLES: Record<Incident["severity"], string> = {
  critical: "border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
};

function durationLabel(iso: string, now: number): string {
  const ms = Math.max(0, now - Date.parse(iso));
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function FreshnessChip({ freshness }: { freshness: string }) {
  const tone =
    freshness === "fresh"
      ? "text-emerald-600 dark:text-emerald-400"
      : freshness === "aging"
        ? "text-amber-600 dark:text-amber-400"
        : freshness === "stale"
          ? "text-red-600 dark:text-red-400"
          : "text-muted-foreground";
  return <span className={cn("text-xs font-medium", tone)}>{freshness}</span>;
}

function IncidentRow({ incident, now }: { incident: Incident; now: number }) {
  const primary = incident.evidence[0];
  return (
    <Link
      href={`/incidents/${encodeURIComponent(incident.id)}`}
      className="block rounded-lg border border-border/60 bg-card/40 p-3 transition-colors hover:bg-accent/40"
      data-testid={`incident-${incident.kind}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", SEVERITY_STYLES[incident.severity])}>
              {incident.severity}
            </span>
            <span className="truncate text-sm font-medium">{incident.title}</span>
            {incident.flapping ? (
              <Badge variant="outline" className="text-[10px]">
                flapping
              </Badge>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>{incident.entity}</span>
            <span>· {durationLabel(incident.firstSeenAt, now)}</span>
            <span>
              · source <span className="font-medium text-foreground/70">{incident.source}</span>
            </span>
            {primary ? (
              <span>
                · freshness <FreshnessChip freshness={primary.freshness} />
              </span>
            ) : null}
          </div>
        </div>
        <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
      </div>
    </Link>
  );
}

export default function IncidentsPage() {
  const { data, loading, error, ready, refresh } = usePoll<IncidentsPayload>("/api/incidents", REFRESH_MS);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Incident Center"
        description="Everything Beacon considers wrong right now — with the evidence, source and freshness that proves it."
        actions={
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="size-4" /> Refresh
          </Button>
        }
      />

      {!ready && loading ? (
        <LoadingPanel rows={4} />
      ) : error && !data ? (
        <ErrorPanel message={error} />
      ) : !data ? (
        <EmptyPanel message="No incident data yet." />
      ) : (
        <>
          {data.confidence.level !== "full" ? (
            <div
              className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400"
              data-testid="confidence-banner"
            >
              <Eye className="mt-0.5 size-4 shrink-0" />
              <div>
                <p className="font-medium">
                  {data.confidence.level === "blind" ? "Beacon observability is blind" : "Beacon observability is degraded"}
                </p>
                <ul className="mt-1 list-inside list-disc text-xs">
                  {data.confidence.reasons.slice(0, 4).map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <AlertTriangle className="size-4 text-amber-500" />
                Active
                <Badge variant="secondary" className="ml-auto text-xs" data-testid="active-count">
                  {data.counts.active}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.active.length === 0 ? (
                <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" data-testid="no-incidents">
                  <CheckCircle2 className="size-4 text-emerald-500" />
                  No active incidents.
                </div>
              ) : (
                data.active.map((incident) => (
                  <IncidentRow key={incident.id} incident={incident} now={Date.parse(data.evaluatedAt)} />
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <FlaskConical className="size-4 text-muted-foreground" />
                Recently recovered
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {data.recovered.length === 0 ? (
                <p className="py-6 text-sm text-muted-foreground">Nothing recovered yet.</p>
              ) : (
                data.recovered.slice(0, 10).map((incident) => (
                  <Link
                    key={incident.id}
                    href={`/incidents/${encodeURIComponent(incident.id)}`}
                    className="block rounded-lg border border-border/40 bg-card/20 p-3 transition-colors hover:bg-accent/30"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-muted-foreground line-through decoration-border">{incident.title}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          lasted {durationLabel(incident.firstSeenAt, Date.parse(incident.resolvedAt ?? incident.lastSeenAt))} ·
                          recovered {formatDateTimeIso(incident.resolvedAt)}
                        </p>
                      </div>
                      <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                    </div>
                  </Link>
                ))
              )}
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Verdict derived from {data.counts.active} active incident(s):{" "}
            {data.counts.critical} critical · {data.counts.warning} warning · {data.counts.info} info. Last evaluated{" "}
            {formatDateTimeIso(data.evaluatedAt)}.
          </p>
        </>
      )}
    </div>
  );
}
