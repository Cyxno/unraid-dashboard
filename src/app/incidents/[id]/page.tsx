"use client";

import Link from "next/link";
import { use, useMemo } from "react";
import { ArrowLeft, BellRing, CircleCheck, CircleDashed, ListOrdered, ShieldQuestion, Zap } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { ErrorPanel, LoadingPanel, PageHeader } from "@/components/dashboard/page-primitives";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatDateTimeIso } from "@/lib/utils";
import type { Incident, ObservabilityConfidence, SourceHealth } from "@/lib/api-types";

/**
 * Incident detail (v1.5.0 Fase 22): what happened, evidence (with source
 * + freshness + evidence type), timeline, impact, notification status and
 * the safe next check. Correlated evidence reads "correlated with" —
 * causality is claimed only for direct evidence.
 */

interface DetailPayload {
  incident: Incident;
  source: SourceHealth | null;
  confidence: ObservabilityConfidence;
}

const EVIDENCE_TYPE_LABEL: Record<string, string> = {
  direct: "direct proof",
  derived: "derived (rule)",
  correlated: "correlated with",
  unknown: "unknown",
};

function EvidenceRow({ evidence }: { evidence: Incident["evidence"][number] }) {
  return (
    <li className="rounded-md border border-border/50 bg-background/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-mono text-[11px] text-muted-foreground">{evidence.signal}</span>
        <Badge variant="outline" className="text-[10px]">
          {EVIDENCE_TYPE_LABEL[evidence.evidenceType] ?? evidence.evidenceType}
        </Badge>
        <span
          className={cn(
            "text-[10px] font-medium",
            evidence.freshness === "fresh"
              ? "text-emerald-600 dark:text-emerald-400"
              : evidence.freshness === "aging"
                ? "text-amber-600 dark:text-amber-400"
                : evidence.freshness === "stale"
                  ? "text-red-600 dark:text-red-400"
                  : "text-muted-foreground",
          )}
        >
          {evidence.freshness}
        </span>
      </div>
      <p className="mt-1 break-words text-sm">{evidence.value}</p>
      <p className="mt-0.5 text-[11px] text-muted-foreground">
        source {evidence.source} · observed {formatDateTimeIso(evidence.observedAt)}
      </p>
    </li>
  );
}

export default function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const url = useMemo(() => `/api/incidents/${encodeURIComponent(id)}`, [id]);
  const { data, loading, error, ready } = usePoll<DetailPayload>(url, 10_000);

  if (!ready && loading) return <LoadingPanel rows={5} />;
  if (error && !data) return <ErrorPanel message={error} />;
  if (!data) return <ErrorPanel message="Incident not found." />;

  const { incident, source } = data;
  const notified = incident.notifiedAt != null;

  return (
    <div className="space-y-6">
      <Link href="/incidents" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Incident Center
      </Link>

      <PageHeader
        title={incident.title}
        description={`${incident.entity} · ${incident.kind}${incident.flapping ? " · flapping" : ""}`}
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">What happened</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5 text-sm">
            <p>{incident.title}</p>
            <p className="text-xs text-muted-foreground">
              First seen {formatDateTimeIso(incident.firstSeenAt)} · last seen {formatDateTimeIso(incident.lastSeenAt)} ·{" "}
              {incident.status === "recovered"
                ? `recovered ${formatDateTimeIso(incident.resolvedAt)} (lasted ${Math.round(incident.durationMs / 60_000)}m)`
                : `active for ${Math.round(incident.durationMs / 60_000)}m`}
            </p>
            <div className="pt-1">
              <Badge variant={incident.severity === "critical" ? "destructive" : "secondary"}>{incident.severity}</Badge>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Source &amp; freshness</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            <p>
              Primary source: <span className="font-medium">{incident.source}</span>
            </p>
            {source ? (
              <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                <li>status: {source.status}</li>
                <li>last success: {formatDateTimeIso(source.lastSuccessAt)}</li>
                <li>data age: {source.ageMs != null ? `${Math.round(source.ageMs / 1000)}s (${source.freshness})` : "never"}</li>
                {source.safeError ? <li className="text-red-600 dark:text-red-400">last error: {source.safeError}</li> : null}
              </ul>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">Source snapshot unavailable.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Zap className="size-4" /> Evidence
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {incident.evidence.map((evidence, index) => (
              <EvidenceRow key={`${evidence.signal}-${index}`} evidence={evidence} />
            ))}
          </ul>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <ListOrdered className="size-4" /> Timeline
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-1.5 text-sm">
              {incident.timeline.slice(0, 12).map((event, index) => (
                <li key={`${event.at}-${index}`} className="flex gap-2">
                  <span className="mt-0.5 font-mono text-[11px] text-muted-foreground">{event.at.slice(11, 19)}</span>
                  <span>
                    {event.event}
                    {event.detail ? <span className="block text-xs text-muted-foreground">{event.detail}</span> : null}
                  </span>
                </li>
              ))}
              {incident.timeline.length === 0 ? <li className="text-muted-foreground">No events recorded.</li> : null}
            </ol>
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Impact</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-inside list-disc space-y-0.5 text-sm text-muted-foreground">
                {incident.impact.map((line) => (
                  <li key={line}>{line}</li>
                ))}
                {incident.impact.length === 0 ? <li>No broader impact identified.</li> : null}
              </ul>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <BellRing className="size-4" /> Notification status
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <p className="flex items-center gap-2">
                {notified ? <CircleCheck className="size-4 text-emerald-500" /> : <CircleDashed className="size-4 text-muted-foreground" />}
                {notified ? `Notified ${formatDateTimeIso(incident.notifiedAt)}` : "Not notified (baseline, preference or recovery)"}
              </p>
              {incident.delivery ? (
                <p className="text-xs text-muted-foreground">
                  Push: {incident.delivery.push ?? "not applicable"} · In-app: {incident.delivery.inApp ?? "not applicable"}
                </p>
              ) : null}
            </CardContent>
          </Card>

          {incident.safeCheck ? (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-medium">
                  <ShieldQuestion className="size-4" /> Safe next check
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground">{incident.safeCheck}</p>
                <p className="mt-2 text-xs text-muted-foreground">Beacon never performs destructive remediation automatically.</p>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
