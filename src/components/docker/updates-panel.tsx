"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowUpCircle, Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import { ConfirmDialog } from "@/components/actions/confirm-dialog";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePoll } from "@/hooks/use-poll";
import { usePwa } from "@/components/layout/pwa-provider";
import { cn, formatDateTimeIso } from "@/lib/utils";

/**
 * Central Docker update overview (v0.7.6, read-only).
 *
 * Detection for ALL containers regardless of origin (Unraid CA, DockerMan,
 * Compose, GHCR, Docker Hub, deploy scripts, local builds). Shows what
 * runs, who manages it, whether an update exists, and which update
 * strategy applies. Mutating actions arrive after the management report
 * is approved — this surface is deliberately read-only.
 */

interface ContainerJob {
  name: string;
  phase: string;
  detail?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
  phases?: Array<{ phase: string; detail: string; at: string }>;
  staleOrphan?: boolean;
  lastResult?: { result: string; image?: string; imageId?: string | null; durationMs?: number; health?: string; error?: string };
}

interface ManagedContainerDto {
  name: string;
  image: string;
  tag: string;
  registry: string;
  management_type: "unraid" | "compose" | "custom_deploy" | "standalone" | "local_build" | "unknown";
  management_source: string;
  update_strategy: string;
  update_available: boolean;
  update_status: "UP_TO_DATE" | "UPDATE_AVAILABLE" | "PINNED" | "LOCAL_BUILD" | "AUTH_REQUIRED" | "UNKNOWN" | "CHECK_FAILED";
  risk: "LOW" | "MEDIUM" | "HIGH";
  policy: "manual" | "notify" | "auto";
  health: string | null;
  current_digest: string | null;
  remote_digest: string | null;
  last_checked: string | null;
}

interface UpdatesPayload {
  available: boolean;
  reason?: string;
  containers: ManagedContainerDto[];
  storage: { mode: string; source: string | null };
  checkedAt: string;
  summary: {
    total: number;
    updatesAvailable: number;
    highRisk: number;
    manualPolicy: number;
    pinned: number;
    localBuilds: number;
  };
}

const STATUS_META: Record<ManagedContainerDto["update_status"], { label: string; variant: "success" | "warning" | "destructive" | "muted" | "secondary" }> = {
  UP_TO_DATE: { label: "up to date", variant: "success" },
  UPDATE_AVAILABLE: { label: "update", variant: "warning" },
  PINNED: { label: "pinned", variant: "secondary" },
  LOCAL_BUILD: { label: "local build", variant: "muted" },
  AUTH_REQUIRED: { label: "auth required", variant: "destructive" },
  UNKNOWN: { label: "unknown", variant: "muted" },
  CHECK_FAILED: { label: "check failed", variant: "destructive" },
};

const MANAGEMENT_LABEL: Record<ManagedContainerDto["management_type"], string> = {
  unraid: "Unraid",
  compose: "Compose",
  custom_deploy: "Deploy script",
  standalone: "Standalone",
  local_build: "Local build",
  unknown: "Unknown",
};

/** Server-side gate mirrored in the UI (the API re-validates anyway). */
function computeGate(container: ManagedContainerDto): { canUpdate: boolean; reason: string | null } {
  const lower = container.name.toLowerCase();
  if (["dumb", "dumbscope", "unraid-dashboard", "unraid-dashboard-helper", "watchtower"].includes(lower)) {
    return {
      canUpdate: false,
      reason: lower === "dumb"
        ? "Part of DUMB AIO — individual update disabled (multiple services run inside)"
        : "Managed externally — dashboard update disabled (own CI/CD or updater)",
    };
  }
  if (container.management_type === "compose") return { canUpdate: false, reason: "Compose-managed — update via docker compose" };
  if (container.management_type === "local_build" || container.update_status === "LOCAL_BUILD") return { canUpdate: false, reason: "Local build — update via its build/deploy pipeline" };
  if (container.update_status === "PINNED") return { canUpdate: false, reason: "Digest pinned — image cannot drift from its pin" };
  if (container.risk === "HIGH") return { canUpdate: false, reason: "HIGH risk (database/auth/proxy/DNS) — update manually via Unraid" };
  if (container.update_status === "AUTH_REQUIRED") return { canUpdate: false, reason: "Registry requires credentials — digest unknown" };
  if (container.update_status === "CHECK_FAILED") return { canUpdate: false, reason: "Registry check failed — no verified update source" };
  if (!container.update_available) return { canUpdate: false, reason: null };
  return { canUpdate: true, reason: null };
}

export function DockerUpdatesPanel() {
  const { online } = usePwa();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const updates = usePoll<UpdatesPayload>("/api/docker/updates", 600_000);
  const data = updates.data;
  const [updateTarget, setUpdateTarget] = useState<ManagedContainerDto | null>(null);
  const [updating, setUpdating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<string | null>(null);
  // Active job: polled every 2s while a machine runs.
  const [activeJob, setActiveJob] = useState<ContainerJob | null>(null);
  const jobRunning = Boolean(
    activeJob && !["completed", "failed", "rolled-back", "rollback-failed"].includes(activeJob.phase),
  );

  const pollJob = useCallback(
    async (name: string) => {
      const response = await fetch(`/api/docker/update-status?name=${encodeURIComponent(name)}`, { cache: "no-store" });
      if (!response.ok) return null;
      const body = (await response.json()) as { job: ContainerJob | null };
      if (body.job) setActiveJob(body.job);
      return body.job;
    },
    [],
  );

  const performRollback = useCallback(async (name: string) => {
    setActionError(null);
    setRollbackTarget(null);
    setActiveJob({ name, phase: "requested" });
    try {
      const response = await fetch("/api/docker/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, confirm: "yes" }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setActionError(body.error ?? "Rollback failed to start.");
        setActiveJob(null);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Rollback request failed.");
      setActiveJob(null);
    }
  }, []);

  const startUpdate = useCallback(async (name: string) => {
    setActionError(null);
    const response = await fetch("/api/docker/update", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, confirm: "yes" }),
    });
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setActionError(body.error ?? "Update failed to start.");
      return;
    }
    setActiveJob({ name, phase: "requested" });
  }, []);

  // While a job runs, poll its status; refresh the overview on completion.
  useEffect(() => {
    if (!activeJob || !jobRunning) return;
    const timer = setInterval(() => {
      void pollJob(activeJob.name).then((job) => {
        if (job && !["requested", "snapshotting", "pulling", "verifying", "recreating", "starting", "health-wait"].includes(job.phase)) {
          updates.refresh();
        }
      });
    }, 2_000);
    return () => clearInterval(timer);
  }, [activeJob, jobRunning, pollJob, updates]);

  const interesting = useMemo(() => {
    if (!data) return [];
    return data.containers
      .filter(
        (container) =>
          container.update_available ||
          container.update_status === "AUTH_REQUIRED" ||
          container.update_status === "CHECK_FAILED",
      )
      .sort((a, b) => {
        const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
        return rank[a.risk] - rank[b.risk];
      });
  }, [data]);

  const refresh = async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const response = await fetch("/api/docker/check-updates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) setRefreshError(body.error ?? "Refresh failed.");
      updates.refresh();
    } catch (error) {
      setRefreshError(error instanceof Error ? error.message : "Refresh failed.");
    } finally {
      setRefreshing(false);
    }
  };

  if (!data) {
    if (updates.loading) {
      return (
        <Card className="mb-4">
          <CardContent className="pt-4 text-xs text-muted-foreground">Update detection loading…</CardContent>
        </Card>
      );
    }
    return (
      <Card className="mb-4">
        <CardContent className="pt-4 text-xs text-muted-foreground">
          {updates.error ?? "Update detection unavailable — the update helper must be configured (UPDATE_HELPER_URL)."}
        </CardContent>
      </Card>
    );
  }

  const s = data.summary;

  return (
    <Card className="mb-4">
      <CardHeader className="gap-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ArrowUpCircle className="size-4 text-muted-foreground" aria-hidden="true" />
          Container updates
          {s.updatesAvailable > 0 ? (
            <Badge variant="warning">
              {s.updatesAvailable} update{s.updatesAvailable === 1 ? "" : "s"} available
            </Badge>
          ) : (
            <Badge variant="success">all up to date</Badge>
          )}
          <Badge variant="muted" title="Docker storage model detected by the update helper">
            {data.storage.mode === "folder" ? "docker folder mode" : data.storage.mode === "image-file" ? "docker image mode" : "storage: unknown"}
          </Badge>
          <span className="ml-auto flex items-center gap-1.5">
            <Button size="sm" variant="outline" disabled={!online || refreshing} onClick={() => void refresh()}>
              <RefreshCw className={cn(refreshing && "animate-spin")} aria-hidden="true" />
              {refreshing ? "Checking…" : "Check now"}
            </Button>
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-1">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span>{s.total} containers</span>
          <span>{s.highRisk} high-risk (manual policy)</span>
          <span>{s.pinned} pinned</span>
          <span>{s.localBuilds} local builds</span>
          <span>last check {formatDateTimeIso(data.checkedAt)}</span>
        </div>

        {refreshError && <p role="alert" className="text-xs text-destructive">{refreshError}</p>}

        {interesting.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            No registry updates detected. Detection covers all {s.total} containers —
            local builds and pinned images are excluded by definition.
          </p>
        ) : (
          <>
            <ul className="space-y-1.5">
              {(showAll ? interesting : interesting.slice(0, 6)).map((container) => (
                <li
                  key={container.name}
                  className="flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate">
                    <Link
                      href={`/docker/${encodeURIComponent(container.name)}`}
                      className="font-medium underline-offset-2 hover:underline"
                    >
                      {container.name}
                    </Link>
                    <span className="ml-2 text-muted-foreground">{MANAGEMENT_LABEL[container.management_type]}</span>
                  </span>
                  {container.risk === "HIGH" && (
                    <Badge variant="destructive" className="gap-1 text-[10px]">
                      <ShieldAlert className="size-3" aria-hidden="true" /> HIGH · manual
                    </Badge>
                  )}
                  {container.risk !== "HIGH" && (
                    <Badge variant="muted" className="text-[10px]">
                      {container.risk} · {container.policy}
                    </Badge>
                  )}
                  <Badge variant={STATUS_META[container.update_status].variant} className="text-[10px]">
                    {STATUS_META[container.update_status].label}
                  </Badge>
                  {container.update_available && (
                    <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline" title="local → remote index digest">
                      {container.current_digest?.slice(7, 15)} → {container.remote_digest?.slice(7, 15)}
                    </span>
                  )}
                  {(() => {
                    const gate = computeGate(container);
                    const isActiveJob = activeJob?.name === container.name && jobRunning;
                    if (isActiveJob) {
                      return (
                        <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-warning">
                          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                          {activeJob?.phase}
                        </span>
                      );
                    }
                    if (gate.canUpdate) {
                      return (
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto h-6 shrink-0 gap-1 px-1.5 text-[10px]"
                          disabled={!online || updating || jobRunning}
                          aria-label={`Update ${container.name}`}
                          onClick={() => setUpdateTarget(container)}
                        >
                          <ArrowUpCircle className="size-3" aria-hidden="true" /> Update
                        </Button>
                      );
                    }
                    if (gate.reason) {
                      return (
                        <span
                          className="ml-auto max-w-[220px] shrink-0 truncate text-right text-[10px] text-muted-foreground"
                          title={gate.reason}
                        >
                          {gate.reason}
                        </span>
                      );
                    }
                    return null;
                  })()}
                </li>
              ))}
            </ul>
            {activeJob && (
              <div
                role="status"
                className={cn(
                  "rounded-md border p-2.5 text-xs",
                  ["failed", "rollback-failed"].includes(activeJob.phase)
                    ? "border-destructive/40 text-destructive"
                    : ["completed", "rolled-back"].includes(activeJob.phase)
                      ? "border-success/40 text-success"
                      : "border-warning/40 text-warning",
                )}
              >
                <p className="flex items-center gap-1.5 font-medium">
                  {jobRunning && <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}
                  {activeJob.name} — {activeJob.phase}
                </p>
                {activeJob.detail && <p className="mt-0.5 text-[11px] text-muted-foreground">{activeJob.detail}</p>}
                {activeJob.lastResult?.error && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-[11px] text-muted-foreground">Error details</summary>
                    <p className="mt-0.5 break-words font-mono text-[11px] text-muted-foreground">{activeJob.lastResult.error}</p>
                  </details>
                )}
                {!jobRunning && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {["completed"].includes(activeJob.phase) && activeJob.lastResult?.image && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-1.5 text-[10px]"
                        disabled={updating}
                        onClick={() => setRollbackTarget(activeJob.name)}
                      >
                        Roll back {activeJob.lastResult.image.split(":").pop()?.slice(0, 20)}
                      </Button>
                    )}
                    {["failed", "rolled-back"].includes(activeJob.phase) && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-1.5 text-[10px]"
                        disabled={updating}
                        onClick={() => {
                          setActiveJob(null);
                          updates.refresh();
                        }}
                      >
                        Dismiss
                      </Button>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}

        <p className="text-[11px] text-muted-foreground">
          Detection is read-only: registry manifests are HEAD-queried (never pulled), and each
          container keeps its own management path (Unraid template, Compose service, deploy script).
          Updates are dispatched through the isolated update helper — never from this page directly.
          Policy defaults: HIGH risk = manual; nothing updates automatically.
        </p>
      </CardContent>
    </Card>
  );
}
