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
    pullAvailable: boolean | null;
    requestEnabled: boolean;
  };
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

        {/* Status line */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {data?.release?.status === "available" && <Badge variant="warning">update available</Badge>}
          {data?.release?.status === "up-to-date" && <Badge variant="success">up to date</Badge>}
          {(!data || data.release?.status === "unknown") && (
            <span className="text-muted-foreground" title={data?.release?.reason}>release check: unknown</span>
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
            The update helper will pull <strong>ghcr.io/cyxno/unraid-dashboard:{targetTag}</strong>, replace
            the container with identical configuration, health-check and verify it, and roll back
            automatically on any failure. The dashboard restarts — this page reconnects afterwards.
          </p>
        </ConfirmDialog>
      </CardContent>
    </Card>
  );
}
