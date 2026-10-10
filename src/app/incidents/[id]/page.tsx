"use client";

import Link from "next/link";
import { use, useCallback, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  BellRing,
  BookOpenCheck,
  CircleCheck,
  CircleDashed,
  ClipboardCheck,
  Hand,
  ListOrdered,
  Loader2,
  ScrollText,
  ShieldCheck,
  ShieldQuestion,
  TriangleAlert,
  Zap,
} from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { ErrorPanel, LoadingPanel, PageHeader } from "@/components/dashboard/page-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/actions/confirm-dialog";
import { cn, formatDateTimeIso } from "@/lib/utils";
import type {
  IncidentDetailPayload,
  OperationRecord,
  OperationState,
  RemediationAction,
} from "@/lib/api-types";

/**
 * Incident detail (v1.5.0 Fase 22 + v1.7.0 Fase 24/25/27): what happened,
 * evidence (with source + freshness + evidence type), impact, RUNBOOK
 * (prerequisites, diagnostic checks, verification, manual recovery,
 * escalation), SAFE ACTIONS with explicit risk badges, operation progress
 * and the incident timeline. Guarded actions always confirm first and
 * show target/effect/rollback; manual-only guidance has no execute path.
 * Correlated evidence reads "correlated with" — causality is claimed only
 * for direct evidence.
 */

const EVIDENCE_TYPE_LABEL: Record<string, string> = {
  direct: "direct proof",
  derived: "derived (rule)",
  correlated: "correlated with",
  unknown: "unknown",
};

const OPERATION_TONE: Record<OperationState, { label: string; variant: "success" | "warning" | "destructive" | "muted" }> = {
  pending: { label: "pending", variant: "muted" },
  executing: { label: "executing", variant: "warning" },
  verifying: { label: "verifying", variant: "warning" },
  succeeded: { label: "succeeded", variant: "success" },
  failed: { label: "failed", variant: "destructive" },
  "timed-out": { label: "timed out", variant: "destructive" },
  "rolled-back": { label: "rolled back", variant: "warning" },
  cancelled: { label: "cancelled", variant: "muted" },
};

function RiskBadge({ action }: { action: RemediationAction }) {
  if (action.risk === "safe") {
    return (
      <Badge variant="outline" className="gap-1 border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
        <ShieldCheck className="size-3" aria-hidden="true" /> SAFE
      </Badge>
    );
  }
  if (action.risk === "guarded") {
    return (
      <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-600 dark:text-amber-400">
        <TriangleAlert className="size-3" aria-hidden="true" /> REQUIRES CONFIRMATION
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <Hand className="size-3" aria-hidden="true" /> MANUAL
    </Badge>
  );
}

function EvidenceRow({ evidence }: { evidence: IncidentDetailPayload["incident"]["evidence"][number] }) {
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

function RunbookCard({ payload }: { payload: IncidentDetailPayload }) {
  const runbook = payload.runbook;
  if (!runbook) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <BookOpenCheck className="size-4" /> Runbook <span className="font-mono text-[11px] text-muted-foreground">{runbook.scope}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="text-muted-foreground">{runbook.explanation}</p>

        {runbook.prerequisites.length > 0 ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Prerequisites</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-muted-foreground">
              {runbook.prerequisites.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {runbook.diagnosticChecks.length > 0 ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Diagnostic checks</p>
            <ol className="mt-1 space-y-1.5">
              {runbook.diagnosticChecks.map((check, index) => (
                <li key={check.title} className="flex gap-2">
                  <span className="mt-0.5 font-mono text-[11px] text-muted-foreground">{index + 1}.</span>
                  <span>
                    {check.title}
                    <span className="block text-xs text-muted-foreground">{check.detail}</span>
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {runbook.verification.length > 0 ? (
          <div>
            <p className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <ClipboardCheck className="size-3.5" aria-hidden="true" /> How recovery is proven
            </p>
            <ul className="mt-1 space-y-1.5">
              {runbook.verification.map((entry) => (
                <li key={entry.title}>
                  {entry.title}
                  <span className="block text-xs text-muted-foreground">{entry.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {runbook.manualRecovery.length > 0 ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Manual recovery (operator)</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-muted-foreground">
              {runbook.manualRecovery.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="flex items-start gap-1.5 rounded-md border border-border/50 bg-background/40 p-2 text-xs text-muted-foreground">
          <ShieldQuestion className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>Escalation: {runbook.escalation}</span>
        </p>
      </CardContent>
    </Card>
  );
}

function OperationRow({ operation }: { operation: OperationRecord }) {
  const tone = OPERATION_TONE[operation.state];
  return (
    <li className="rounded-md border border-border/50 bg-background/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant={tone.variant}>{tone.label}</Badge>
        <span className="font-mono text-[11px] text-muted-foreground">{operation.operation}</span>
        <span className="text-[11px] text-muted-foreground">
          started {formatDateTimeIso(operation.startedAt)} · by {operation.actor}
        </span>
      </div>
      {operation.message ? <p className="mt-1 break-words text-sm">{operation.message}</p> : null}
      <ol className="mt-1 space-y-0.5">
        {operation.timeline.slice(0, 5).map((event, index) => (
          <li key={`${event.at}-${index}`} className="flex gap-2 text-[11px] text-muted-foreground">
            <span className="font-mono">{event.at.slice(11, 19)}</span>
            <span>
              {event.event}
              {event.detail ? ` — ${event.detail}` : ""}
            </span>
          </li>
        ))}
      </ol>
    </li>
  );
}

export default function IncidentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const url = useMemo(() => `/api/incidents/${encodeURIComponent(id)}`, [id]);
  const { data, loading, error, ready, refresh } = usePoll<IncidentDetailPayload>(url, 10_000);

  const [pendingAction, setPendingAction] = useState<RemediationAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const requestIdRef = useRef<string>("");

  const activeOperation = data?.operations.find((operation) =>
    ["pending", "executing", "verifying"].includes(operation.state),
  );

  const openConfirm = useCallback((action: RemediationAction) => {
    // One stable requestId per confirmation dialog: a double-click or a
    // retried submit converges on one operation (server-side idempotency).
    requestIdRef.current =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setResult(null);
    setPendingAction(action);
  }, []);

  const runAction = useCallback(
    async (action: RemediationAction) => {
      setBusy(true);
      try {
        const response = await fetch("/api/remediation/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            incidentId: action.incidentId,
            actionId: action.id,
            ...(requestIdRef.current ? { requestId: requestIdRef.current } : {}),
          }),
        });
        const body = (await response.json()) as { ok?: boolean; message?: string; duplicate?: boolean; state?: string };
        setResult({
          ok: Boolean(body.ok),
          message: body.message ?? (response.ok ? "Accepted." : `Refused (HTTP ${response.status}).`),
        });
        void refresh();
      } catch {
        setResult({ ok: false, message: "Request failed — the server did not answer." });
      } finally {
        setBusy(false);
        setPendingAction(null);
      }
    },
    [refresh],
  );

  if (!ready && loading) return <LoadingPanel rows={5} />;
  if (error && !data) return <ErrorPanel message={error} />;
  if (!data) return <ErrorPanel message="Incident not found." />;

  const { incident, source } = data;
  const notified = incident.notifiedAt != null;
  const diagnostics = data.actions.filter((action) => action.risk === "safe");
  const guarded = data.actions.filter((action) => action.risk === "guarded");

  return (
    <div className="space-y-6">
      <Link href="/incidents" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Incident Center
      </Link>

      <PageHeader
        title={incident.title}
        description={`${incident.entity} · ${incident.kind}${incident.flapping ? " · flapping" : ""}`}
      />

      {data.demoActive ? (
        <p role="status" className="rounded-lg border border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
          <Badge variant="outline" className="mr-2">DEMO</Badge>
          Runbooks and action previews are shown with synthetic data. All mutations are disabled in demo mode.
        </p>
      ) : null}

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
        <RunbookCard payload={data} />

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <ShieldCheck className="size-4" /> Safe actions
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {diagnostics.length === 0 && guarded.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No actions are offered for this incident — follow the runbook guidance. Beacon never performs
                  destructive remediation automatically.
                </p>
              ) : null}
              {diagnostics.map((action) => (
                <div key={action.id} className="rounded-md border border-border/50 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <RiskBadge action={action} />
                    <span className="text-sm font-medium">{action.title}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{action.description}</p>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    disabled={busy || Boolean(data.demoActive) || Boolean(activeOperation)}
                    onClick={() => void runAction(action)}
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
                    Run now
                  </Button>
                </div>
              ))}
              {guarded.map((action) => (
                <div key={action.id} className="rounded-md border border-amber-500/30 p-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <RiskBadge action={action} />
                    <span className="text-sm font-medium">{action.title}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{action.description}</p>
                  <Button
                    variant="warning"
                    size="sm"
                    className="mt-2"
                    disabled={busy || Boolean(activeOperation)}
                    onClick={() => openConfirm(action)}
                  >
                    {data.demoActive ? "Preview confirmation" : "Open confirmation"}
                  </Button>
                </div>
              ))}
              {result ? (
                <p
                  role="status"
                  className={cn(
                    "rounded-md border px-2.5 py-2 text-xs",
                    result.ok
                      ? "border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                      : "border-destructive/40 bg-destructive/5 text-red-600 dark:text-red-400",
                  )}
                >
                  {result.message}
                </p>
              ) : null}
              {activeOperation ? (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  An operation is {activeOperation.state} on this entity — conflicting actions are blocked until it finishes.
                </p>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <ScrollText className="size-4" /> Operations
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2">
                {data.operations.slice(0, 5).map((operation) => (
                  <OperationRow key={operation.id} operation={operation} />
                ))}
                {data.operations.length === 0 ? (
                  <li className="text-sm text-muted-foreground">No remediation operations recorded for this incident.</li>
                ) : null}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

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

      <ConfirmDialog
        open={pendingAction !== null}
        title={pendingAction ? `Confirm: ${pendingAction.title}` : ""}
        confirmLabel={pendingAction?.type === "verified-update-retry" ? "Retry verified update" : "Execute"}
        severity="warning"
        busy={busy}
        confirmDisabled={Boolean(data.demoActive)}
        onConfirm={() => pendingAction && void runAction(pendingAction)}
        onCancel={() => setPendingAction(null)}
      >
        {pendingAction ? (
          <div className="space-y-1 text-xs">
            <p>
              <span className="font-medium text-foreground">Action:</span> {pendingAction.title}
            </p>
            <p>
              <span className="font-medium text-foreground">Target:</span> {pendingAction.entity}
            </p>
            <p>
              <span className="font-medium text-foreground">Expected effect:</span> {pendingAction.verification.join("; ")}
            </p>
            <p>
              <span className="font-medium text-foreground">Risk:</span> guarded — runs only after its preconditions are
              re-checked against live state.
            </p>
            <p>
              <span className="font-medium text-foreground">Rollback:</span>{" "}
              {pendingAction.reversible
                ? "reversible via the existing flows (counter-action / update rollback snapshot)."
                : "not reversible — reconsider carefully."}
            </p>
            <p className="pt-1 text-[11px] text-muted-foreground">
              Preconditions: {pendingAction.preconditions.join(" · ")}
            </p>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
