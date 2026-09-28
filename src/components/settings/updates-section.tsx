"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  CircleDashed,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  Rocket,
  ShieldQuestion,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/actions/confirm-dialog";
import { usePoll } from "@/hooks/use-poll";
import { usePwa } from "@/components/layout/pwa-provider";
import { useLive } from "@/components/layout/live-events";
import { formatDateTimeIso } from "@/lib/utils";
import { cn } from "@/lib/utils";
import type { BuildInfoDto } from "@/lib/api-types";

/**
 * Settings → Updates (v0.7): current vs latest as stacked cards, the
 * helper's real phase timeline, one primary action, explicit
 * confirmation. Progress reflects actual helper phases (SSE `update`
 * events + a 5s status poll while a machine runs) — never synthetic.
 */

interface UpdateHistoryEntry {
  timestamp: string;
  startedAt: string;
  actor: string;
  fromVersion: string;
  toVersion: string;
  durationMs: number;
  result: "success" | "rolled-back" | "failed";
  rollbackPerformed: boolean;
  usedLocalImage: boolean;
  error?: string;
}

interface UpdateStatusPayload {
  build: BuildInfoDto;
  release: {
    status: "up-to-date" | "available" | "unknown";
    reason?: string;
    latestTag: string | null;
    latestManifestDigest: string | null;
    latestRevisionSha: string | null;
    registry: { tokenConfigured: boolean; reachable: boolean | null; authorized: boolean | null; reason: string | null };
  } | null;
  releaseSource: "registry" | "local" | "none";
  consistency: {
    versionMatchesTag: boolean | null;
    shaMatchesRevision: boolean | null;
    runningDigest: string | null;
    registryDigest: string | null;
    locallyBuiltOnly: boolean;
    unknownRegistryState: boolean;
    summary: string;
  };
  history: UpdateHistoryEntry[];
  helper: {
    configured: boolean;
    reachable: boolean | null;
    reason: string | null;
    helperVersion: string | null;
    phase: string | null;
    detail: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    log: Array<{ at: string; phase: string; detail: string }>;
    lastUpdate: {
      from: string; to: string; result: string;
      startedAt: string; finishedAt: string; durationMs: number;
      digest?: string | null; usedLocalImage?: boolean; error?: string;
    } | null;
    currentImage: string | null;
    currentVersion: string | null;
    currentImageId: string | null;
    localVersions: string[];
    pullAvailable: boolean | null;
    requestEnabled: boolean;
  };
  rollbackCandidates: string[];
  updateInProgress: boolean;
}

const PHASE_SEQUENCE = [
  "requested",
  "checking",
  "pulling",
  "validating",
  "replacing",
  "healthchecking",
  "verifying",
  "complete",
] as const;

const PHASE_LABELS: Record<string, string> = {
  requested: "Requested",
  checking: "Capturing configuration",
  pulling: "Pulling image",
  validating: "Validating image",
  replacing: "Replacing container",
  healthchecking: "Health checking",
  verifying: "Verifying live data",
  complete: "Complete",
  rollback: "Rolling back",
  failed: "Failed",
};

function PhaseTimeline({ currentPhase }: { currentPhase: string }) {
  const activeIndex = PHASE_SEQUENCE.indexOf(currentPhase as (typeof PHASE_SEQUENCE)[number]);
  const rollingBack = currentPhase === "rollback" || currentPhase === "failed";
  const failed = currentPhase === "failed";

  return (
    <ol aria-label="Update progress" className="space-y-1.5">
      {PHASE_SEQUENCE.map((phase, index) => {
        const done = !rollingBack && activeIndex >= 0 && index < activeIndex;
        const active = !rollingBack && phase === currentPhase;
        const Icon = done ? CheckCircle2 : active ? Loader2 : CircleDashed;
        return (
          <li key={phase} className={cn("flex items-center gap-2 text-xs", !done && !active && "text-muted-foreground")}>
            <Icon className={cn("size-3.5 shrink-0", active && "animate-spin text-warning", done && "text-success")} aria-hidden="true" />
            <span>{PHASE_LABELS[phase] ?? phase}</span>
            {active && <span className="text-warning">…</span>}
          </li>
        );
      })}
      {rollingBack && (
        <li className={cn("flex items-center gap-2 text-xs", failed ? "text-destructive" : "text-warning")}>
          {failed ? <XCircle className="size-3.5" aria-hidden="true" /> : <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
          {PHASE_LABELS[currentPhase] ?? currentPhase}
        </li>
      )}
    </ol>
  );
}

export function UpdatesSection() {
  const { online } = usePwa();
  const { updatePhase: livePhase } = useLive();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);

  // Poll fast while a machine runs (SSE is primary; this is the fallback
  // that also survives a page reload mid-update).
  const status = usePoll<UpdateStatusPayload>("/api/update/status", 5_000);
  const data = status.data;
  const machineRunning = data?.updateInProgress || Boolean(
    livePhase && !["idle", "complete", "failed"].includes(livePhase.phase),
  );
  const phase = livePhase?.phase ?? data?.helper.phase ?? "idle";
  const targetTag = data?.release?.latestTag ?? null;
  const currentVersion = data?.build.version ?? null;
  const updateAvailable = data?.release?.status === "available";

  // While a machine runs, poll the status endpoint aggressively.
  useEffect(() => {
    if (!machineRunning) return;
    const timer = setInterval(() => status.refresh(), 5_000);
    return () => clearInterval(timer);
  }, [machineRunning, status]);

  const requestUpdate = useCallback(async () => {
    if (!targetTag) return;
    setRequesting(true);
    setRequestError(null);
    try {
      const response = await fetch("/api/update/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tag: targetTag, confirm: "yes" }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setRequestError(body.error ?? `Update request failed (HTTP ${response.status}).`);
      }
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Update request failed.");
    } finally {
      setRequesting(false);
      setConfirmOpen(false);
    }
  }, [targetTag]);

  const performRollback = useCallback(
    async (tag: string) => {
      setRequesting(true);
      setRequestError(null);
      try {
        const response = await fetch("/api/update/rollback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tag, confirm: "yes" }),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) {
          setRequestError(body.error ?? `Rollback failed (HTTP ${response.status}).`);
        }
      } catch (error) {
        setRequestError(error instanceof Error ? error.message : "Rollback request failed.");
      } finally {
        setRequesting(false);
        setRollbackTarget(null);
      }
    },
    [],
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="size-4 text-muted-foreground" aria-hidden="true" />
          Updates
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-1">
        {/* Stacked current/latest cards (mobile-first) */}
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Running</p>
            <p className="font-mono text-2xl font-semibold tabular-nums">
              {data ? `v${currentVersion}` : "—"}
            </p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {data?.build.gitSha ? data.build.gitSha.slice(0, 7) : "dev"}
              {data?.helper.currentImageId ? ` · img ${(data.helper.currentImageId ?? "").slice(7, 19)}` : ""}
            </p>
          </div>
          <div className="rounded-lg border p-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Latest release</p>
            <p className="font-mono text-2xl font-semibold tabular-nums">
              {data ? (data.release?.latestTag ? `v${data.release.latestTag}` : "—") : "—"}
            </p>
            <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {data?.release?.latestManifestDigest ? `digest ${data.release.latestManifestDigest.slice(7, 19)}` : ""}
            </p>
          </div>
        </div>

        {/* GHCR auth (v0.7.13): private pulls are impossible without the
            host login. Surface it loudly — this is the #1 update blocker. */}
        {data?.helper.pullAvailable === false && (
          <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
            <p className="text-sm font-semibold">GHCR login required</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              The host cannot pull private images from <code>ghcr.io/cyxno/*</code>. Fix with one command on the host:{" "}
              <code className="rounded bg-muted px-1">sh scripts/login-ghcr.sh</code> (a{" "}
              <code className="rounded bg-muted px-1">read:packages</code> PAT, input hidden, never stored in this
              app). The credential persists across reboots and helper restarts.
            </p>
          </div>
        )}

        {/* Status line */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {data?.release?.status === "available" && <Badge variant="warning">update available</Badge>}
          {data?.release?.status === "up-to-date" && <Badge variant="success">up to date</Badge>}
          {(!data || data.release?.status === "unknown") && (
            <span className="text-muted-foreground" title={data?.release?.reason}>release check: unknown</span>
          )}
          {data?.releaseSource === "local" && (
            <Badge variant="muted" title="Discovery from locally present images — the host has no GHCR login">
              source: local images
            </Badge>
          )}
          <span className="flex items-center gap-1 text-muted-foreground">
            <HardDriveDownload className="size-3" aria-hidden="true" />
            registry pull:{" "}
            {data?.helper.pullAvailable === true ? (
              <Badge variant="success">available</Badge>
            ) : data?.helper.pullAvailable === false ? (
              <Badge variant="warning">login required (scripts/login-ghcr.sh)</Badge>
            ) : (
              "unknown"
            )}
          </span>
        </div>

        {/* Version/digest consistency (v0.7.1) — informational, not alarms */}
        {data?.consistency && (
          <p
            className={cn(
              "text-[11px]",
              data.consistency.summary === "consistent" ? "text-muted-foreground" : "text-warning",
            )}
            title="Informational — mismatches are not treated as security incidents"
          >
            Consistency: {data.consistency.summary}
            {data.consistency.versionMatchesTag === false && " · version/label mismatch"}
            {data.consistency.shaMatchesRevision === false && " · SHA/revision mismatch"}
          </p>
        )}

        {/* Helper state */}
        {data?.helper && !data.helper.configured && (
          <p className="text-xs text-muted-foreground">{data.helper.reason}</p>
        )}
        {data?.helper?.configured && !data.helper.reachable && (
          <p className="text-xs text-warning" title={data.helper.reason ?? undefined}>
            Update helper unreachable — in-app updates unavailable. Host-side script still works.
          </p>
        )}
        {data?.helper?.configured && data.helper.reachable && (
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            <span>helper v{data.helper.helperVersion ?? "?"}</span>
            <span>
              last update:{" "}
              {data.helper.lastUpdate
                ? `${data.helper.lastUpdate.result} · ${data.helper.lastUpdate.from.split(":").pop()} → ${data.helper.lastUpdate.to.split(":").pop()} · ${Math.round(data.helper.lastUpdate.durationMs / 1000)}s`
                : "none yet"}
            </span>
          </div>
        )}

        {/* Live phase timeline while a machine runs */}
        {machineRunning && (
          <div className="rounded-lg border border-warning/30 bg-warning/5 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-warning">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              Update in progress — lifecycle actions are disabled
            </p>
            <PhaseTimeline currentPhase={phase} />
            {livePhase?.detail && <p className="mt-2 truncate text-[11px] text-muted-foreground">{livePhase.detail}</p>}
          </div>
        )}

        {/* Last update result */}
        {!machineRunning && data?.helper.lastUpdate && (
          <p className="text-xs text-muted-foreground">
            Last update {formatDateTimeIso(data.helper.lastUpdate.finishedAt)}:{" "}
            <span className={cn(data.helper.lastUpdate.result === "success" ? "text-success" : "text-warning")}>
              {data.helper.lastUpdate.result}
            </span>
            {data.helper.lastUpdate.error ? ` — ${data.helper.lastUpdate.error}` : ""}
          </p>
        )}

        {requestError && (
          <p role="alert" className="text-xs text-destructive">{requestError}</p>
        )}

        {/* One primary action */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button size="sm" variant="outline" disabled={!online || status.loading} onClick={() => status.refresh()}>
            <RefreshCw aria-hidden="true" /> Check for updates
          </Button>
          <Button
            size="sm"
            disabled={
              !online ||
              !updateAvailable ||
              machineRunning ||
              requesting ||
              !data?.helper.requestEnabled ||
              !targetTag
            }
            onClick={() => setConfirmOpen(true)}
          >
            <ArrowDownToLine aria-hidden="true" />
            Update to v{targetTag ?? "…"}
          </Button>
        </div>
        {!data?.helper.requestEnabled && data?.helper.configured && (
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <ShieldQuestion className="size-3" aria-hidden="true" />
            In-app updates need UPDATE_HELPER_TOKEN on the dashboard container.
          </p>
        )}

        <ConfirmDialog
          open={confirmOpen}
          title={`Update dashboard to v${targetTag ?? ""}?`}
          severity="warning"
          busy={requesting}
          confirmLabel="Start update"
          onConfirm={() => void requestUpdate()}
          onCancel={() => setConfirmOpen(false)}
        >
          <p>
            The update helper will apply{" "}
            <strong>ghcr.io/cyxno/unraid-dashboard:{targetTag}</strong>{" "}
            {data?.helper.pullAvailable === false ? "(from the locally built image — the host has no GHCR login)" : "from GHCR"},
            replace the container with identical configuration, health-check and verify it, and roll
            back automatically on any failure. The dashboard restarts — this page reconnects afterwards.
          </p>
        </ConfirmDialog>

        {/* Update history (v0.7.1) — mobile-friendly cards */}
        {data?.history && data.history.length > 0 && (
          <div>
            <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Update history
            </p>
            <ul className="space-y-1.5">
              {data.history.slice(0, 6).map((entry, index) => (
                <li key={`${entry.startedAt}-${index}`} className="rounded-md border p-2.5 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      variant={
                        entry.result === "success"
                          ? "success"
                          : entry.result === "rolled-back"
                            ? "warning"
                            : "destructive"
                      }
                    >
                      {entry.result}
                    </Badge>
                    <span className="font-mono">
                      v{entry.fromVersion} → v{entry.toVersion}
                    </span>
                    {entry.rollbackPerformed && <Badge variant="warning">rollback performed</Badge>}
                    {entry.usedLocalImage && <Badge variant="muted">local image</Badge>}
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {formatDateTimeIso(entry.timestamp)} · {entry.actor} ·{" "}
                    {entry.durationMs >= 1000 ? `${Math.round(entry.durationMs / 1000)}s` : `${entry.durationMs}ms`}
                    {entry.error ? ` · ${entry.error.slice(0, 90)}` : ""}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Persisted to /app/data/update-history.jsonl — survives container replacement.
            </p>
          </div>
        )}

        {/* Rollback (v0.7.4) — only to validated releases, strong confirmation */}
        {!machineRunning && (data?.rollbackCandidates.length ?? 0) > 0 && (
          <div className="rounded-md border p-2.5 text-xs">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Rollback — validated releases on this host
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              {data!.rollbackCandidates
                .filter((tag: string) => tag !== data?.build.version)
                .slice(0, 3)
                .map((tag: string) => (
                  <Button
                    key={tag}
                    size="sm"
                    variant="outline"
                    disabled={requesting || !online}
                    onClick={() => setRollbackTarget(tag)}
                  >
                    Roll back to v{tag}
                  </Button>
                ))}
              {data!.rollbackCandidates.filter((tag: string) => tag !== data?.build.version).length === 0 && (
                <span className="text-muted-foreground">
                  Only the current version is validated — nothing to roll back to.
                </span>
              )}
            </div>
          </div>
        )}
        {rollbackTarget && (
          <ConfirmDialog
            open
            title={`Roll back to v${rollbackTarget}?`}
            severity="destructive"
            busy={requesting}
            confirmLabel="Roll back now"
            onConfirm={() => void performRollback(rollbackTarget)}
            onCancel={() => setRollbackTarget(null)}
          >
            <p>
              The helper replaces the dashboard with the validated{" "}
              <strong>v{rollbackTarget}</strong> image (same safety path as an update: config
              preserved, health-checked, verified — automatic restore if it fails). The dashboard
              restarts.
            </p>
          </ConfirmDialog>
        )}
      </CardContent>
    </Card>
  );
}
