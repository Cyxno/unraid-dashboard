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
  management_type: "unraid" | "compose" | "custom_deploy" | "standalone" | "local_build" | "pipeline_owned" | "unknown";
  management_source: string;
  update_strategy: string;
  update_available: boolean;
  update_status: "UP_TO_DATE" | "UPDATE_AVAILABLE" | "PINNED" | "LOCAL_BUILD" | "AUTH_REQUIRED" | "UNKNOWN" | "CHECK_FAILED";
  risk: "LOW" | "MEDIUM" | "HIGH";
  policy: "manual" | "notify" | "auto";
  externallyManaged?: boolean;
  health: string | null;
  current_digest: string | null;
  remote_digest: string | null;
  last_checked: string | null;
  rollback?: {
    ready: boolean;
    level: "ready" | "unproven" | "not_ready";
    snapshot_present: boolean;
  };
  provenance?: {
    state: "synced" | "registry_ahead" | "local_build" | "auth_required" | "check_failed" | "unknown";
    note: string | null;
  };
  unsupported?: string[];
}

interface UpdatesPayload {
  checking?: boolean;
  pending?: number;
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
  pipeline_owned: "Pipeline",
  unknown: "Unknown",
};

const PROVENANCE_META: Record<NonNullable<ManagedContainerDto["provenance"]>["state"], { label: string; variant: "success" | "warning" | "destructive" | "muted" | "secondary" }> = {
  synced: { label: "provenance synced", variant: "success" },
  registry_ahead: { label: "registry ahead", variant: "warning" },
  local_build: { label: "locally built", variant: "muted" },
  auth_required: { label: "registry auth", variant: "destructive" },
  check_failed: { label: "check failed", variant: "destructive" },
  unknown: { label: "provenance ?", variant: "secondary" },
};

/**
 * Server-side gate mirrored in the UI (the API re-validates anyway).
 * v0.7.13: compose services update through the dashboard like any other
 * container (unless HIGH-risk), pipeline-owned projects are always
 * refused, and mutation requires a resolvable rollback image.
 */
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
  if (container.management_type === "pipeline_owned") {
    return { canUpdate: false, reason: "Managed by external deployment pipeline — dashboard never mutates this project" };
  }
  if (container.externallyManaged === true) {
    return { canUpdate: false, reason: "Managed externally (label) — dashboard update disabled" };
  }
  if ((container.unsupported ?? []).length > 0) {
    return { canUpdate: false, reason: "Config not generically recreatable: " + (container.unsupported ?? []).join("; ") };
  }
  if (container.rollback && !container.rollback.ready) {
    return { canUpdate: false, reason: "Rollback not ready: running image not resolvable — refusing mutation" };
  }
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
  // §12 filter-chips: updates / blocked / local build / alles
  type PanelFilter = "updates" | "blocked" | "local" | "all";
  const [filter, setFilter] = useState<PanelFilter>("updates");
  const updates = usePoll<UpdatesPayload>("/api/docker/updates", 600_000);
  const data = updates.data;
  // Koude cache: de eerste sweep draait op de achtergrond — poll sneller.
  const checking = data?.checking === true;
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => updates.refresh(), 3_000);
    return () => clearInterval(timer);
  }, [checking, updates]);
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
    const rows = data.containers.filter(
      (container) =>
        container.update_available ||
        container.update_status === "AUTH_REQUIRED" ||
        container.update_status === "CHECK_FAILED",
    );
    void rows;
    return data.containers;
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
    const rows = data.containers.filter((container) => {
      switch (filter) {
        case "updates":
          return container.update_available;
        case "blocked": {
          const gate = computeGate(container);
          return !gate.canUpdate && Boolean(gate.reason);
        }
        case "local":
          return container.update_status === "LOCAL_BUILD";
        default:
          return true;
      }
    });
    return rows.sort((a, b) => {
      if (a.update_available !== b.update_available) return a.update_available ? -1 : 1;
      return rank[a.risk] - rank[b.risk];
    });
  }, [data, filter]);

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
          <CardContent className="pt-4 text-xs text-muted-foreground">Checking container updates…</CardContent>
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

  // Demo/failed payloads may lack a summary block — degrade, never crash.
  const s = data.summary ?? {
    total: 0,
    updatesAvailable: 0,
    highRisk: 0,
    manualPolicy: 0,
    pinned: 0,
    localBuilds: 0,
  };

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
        {data.checking && (
          <p role="status" className="flex items-center gap-1.5 text-xs text-warning">
            <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
            Checking updates across {s.total} containers — results appear as they come in…
          </p>
        )}
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
          <span>{s.total} containers</span>
          <span>{s.highRisk} high-risk (manual policy)</span>
          <span>{s.pinned} pinned</span>
          <span>{s.localBuilds} local builds</span>
          <span>last check {formatDateTimeIso(data.checkedAt)}</span>
        </div>

        {refreshError && <p role="alert" className="text-xs text-destructive">{refreshError}</p>}
        {actionError && (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
            {actionError}
          </p>
        )}

        {filtered.length === 0 ? (
          <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            {filter === "updates"
              ? "No registry updates detected — local builds and pinned images are excluded by definition."
              : "No containers match this filter."}
          </p>
        ) : (
          <>
            <div role="group" aria-label="Filter containers" className="mb-2 flex flex-wrap items-center gap-1">
              {([
                ["updates", `Updates (${data.containers.filter((c) => c.update_available).length})`],
                ["blocked", "Blocked"],
                ["local", "Local builds"],
                ["all", `All (${data.containers.length})`],
              ] as const).map(([value, label]) => (
                <Button
                  key={value}
                  size="sm"
                  variant={filter === value ? "secondary" : "ghost"}
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value as PanelFilter)}
                  className="h-7 px-2 text-[11px]"
                >
                  {label}
                </Button>
              ))}
            </div>
            <ul className="space-y-1.5">
              {(showAll ? filtered : filtered.slice(0, 6)).map((container) => (
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
                  {container.management_type === "pipeline_owned" && (
                    <Badge variant="warning" className="gap-1 text-[10px]" title="Managed by external deployment pipeline — read-only here">
                      pipeline
                    </Badge>
                  )}
                  {container.provenance && container.provenance.state !== "unknown" && container.provenance.state !== "synced" && (
                    <Badge
                      variant={PROVENANCE_META[container.provenance.state].variant}
                      className="hidden text-[10px] lg:inline-flex"
                      title={container.provenance.note ?? undefined}
                    >
                      {PROVENANCE_META[container.provenance.state].label}
                    </Badge>
                  )}
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
        {updateTarget && (
          <ConfirmDialog
            open
            title={`Update ${updateTarget.name}?`}
            severity={updateTarget.risk === "HIGH" ? "destructive" : "warning"}
            busy={updating}
            confirmLabel="Start update"
            onConfirm={() => {
              const target = updateTarget;
              setUpdateTarget(null);
              void startUpdate(target.name);
            }}
            onCancel={() => setUpdateTarget(null)}
          >
            <p>
              The helper snapshots the exact container configuration, pulls{" "}
              <strong>{updateTarget.image}</strong>, recreates the container identically and
              verifies health — rolling back automatically on any failure. The container restarts
              briefly. Audit records this as your identity.
            </p>
            <p className="text-[11px]">
              Management: {MANAGEMENT_LABEL[updateTarget.management_type]} · risk {updateTarget.risk} ·
              policy {updateTarget.policy}
            </p>
          </ConfirmDialog>
        )}
        {rollbackTarget && (
          <ConfirmDialog
            open
            title={`Roll back ${rollbackTarget}?`}
            severity="destructive"
            busy={updating}
            confirmLabel="Roll back now"
            onConfirm={() => void performRollback(rollbackTarget)}
            onCancel={() => setRollbackTarget(null)}
          >
            <p>
              The container is recreated from the stored pre-update snapshot (previous image +
              exact configuration) and health-verified. If the rollback itself fails, manual
              recovery is required.
            </p>
          </ConfirmDialog>
        )}
      </CardContent>
    </Card>
  );
}
