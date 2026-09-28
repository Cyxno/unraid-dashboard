"use client";

import { useCallback, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  DatabaseBackup,
  HardDriveDownload,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader, LoadingPanel, ErrorPanel } from "@/components/dashboard/page-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatDateTimeIso } from "@/lib/utils";

/**
 * Operations page (v0.7.13): the operator's "what is broken?" view.
 * Read-only status for every dependency plus the four safe recovery
 * actions. No shell, no arbitrary restore, no arbitrary rollback.
 */

interface OperationsStatus {
  generatedAt: string;
  app: {
    healthy: boolean;
    version: string;
    gitSha: string | null;
    buildTime: string | null;
    authMode: string;
    dataDirWritable: boolean | null;
    dataVolumeFreeBytes: number | null;
  };
  dependencies: {
    unraid: { reachable: boolean | null; latencyMs: number | null };
    prometheus: { reachable: boolean; latencyMs: number | null; configured: boolean };
    helper: { reachable: boolean | null; configured: boolean; version: string | null; reason: string | null };
  };
  ghcr: {
    state: "ok" | "auth_required" | "unknown";
    message: string | null;
    tokenConfigured: boolean;
    registryAuthorized: boolean | null;
    latestTag: string | null;
    status: string | null;
    reason: string | null;
  };
  persistence: {
    backupsPresent: number;
    latestBackup: { file: string; createdAt: string; bytes: number } | null;
  };
  updates: {
    latestSuccessful: { toVersion: string; at: string; usedLocalImage: boolean; scope: string; target: string | null } | null;
    latestRollback: { scope: string; target: string | null; at: string } | null;
    rollbackImage: { tag: string | null; imageId: string | null; currentVersion: string | null; localVersions: string[] };
    pilotAutoEnabled: boolean;
  };
  operations: {
    active: { kind: string; target: string | null; phase: string; startedAt: string | null; stale: boolean } | null;
    staleCandidates: Array<{ job: string; phase: string; startedAt: string | null }>;
  };
}

type ActionName = "backup-create" | "backup-validate" | "backup-dry-run" | "retry-dependency-check" | "clear-stale-operation";

interface ActionResult {
  ok: boolean;
  action: string;
  error?: string;
  result?: {
    file?: string;
    bytes?: number;
    cleared?: string[];
    refused?: Array<{ job: string; reason: string }>;
    note?: string;
    dryRun?: { wouldRestoreDashboards: number; updateHistoryLines: number; note: string };
  };
  reason?: string;
  entries?: number;
}

function StatusRow({
  label,
  ok,
  detail,
  unknown,
}: {
  label: string;
  ok: boolean | null;
  detail: string;
  unknown?: boolean;
}) {
  const Icon = ok === null || unknown ? CircleDashed : ok ? CheckCircle2 : XCircle;
  const tone = ok === null || unknown ? "text-muted-foreground" : ok ? "text-emerald-500" : "text-destructive";
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="flex min-w-0 items-start gap-2">
        <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          <div className="break-words text-xs text-muted-foreground">{detail}</div>
        </div>
      </div>
    </div>
  );
}

export default function OperationsPage() {
  const status = usePoll<OperationsStatus>("/api/operations", 15_000);
  const [busyAction, setBusyAction] = useState<ActionName | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ActionResult | null>(null);

  const runAction = useCallback(async (action: ActionName) => {
    setBusyAction(action);
    setActionError(null);
    setLastResult(null);
    try {
      const response = await fetch("/api/operations/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const body = (await response.json().catch(() => ({}))) as ActionResult;
      setLastResult({ ...body, action });
      if (!response.ok) {
        setActionError(body.error ?? `Action failed (HTTP ${response.status}).`);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Action failed.");
    } finally {
      setBusyAction(null);
      if (action === "backup-create") status.refresh();
    }
  }, [status]);

  const data = status.data;
  const ghcrBanner = data?.ghcr.state === "auth_required";

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <PageHeader
        title="Operations"
        description="What is broken? Read-only status of every dependency, plus safe recovery actions."
        actions={
          <Button variant="outline" size="sm" onClick={status.refresh} disabled={status.loading}>
            <RefreshCw className={cn("size-4", status.loading && "animate-spin")} aria-hidden />
            Refresh
          </Button>
        }
      />

      {ghcrBanner && (
        <Card className="mb-4 border-amber-500/40 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 py-3">
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" aria-hidden />
            <div className="min-w-0">
              <div className="text-sm font-semibold">GHCR login required</div>
              <p className="mt-0.5 break-words text-sm text-muted-foreground">
                {data?.ghcr.message ?? "Private image pulls are blocked."} Run{" "}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">sh scripts/login-ghcr.sh</code> on the host once
                (a <code className="rounded bg-muted px-1 py-0.5 text-xs">read:packages</code> PAT, input hidden). The
                credential then persists across reboots and helper restarts.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {status.error && !data && <ErrorPanel message={status.error} />}
      {!data && !status.error && <LoadingPanel rows={6} />}

      {data && (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* App */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Activity className="size-4 text-muted-foreground" aria-hidden /> Dashboard app
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <StatusRow label="App health" ok={data.app.healthy} detail={`v${data.app.version} · ${data.app.gitSha?.slice(0, 7) ?? "unknown sha"}`} />
              <StatusRow
                label="Auth mode"
                ok={true}
                detail={`${data.app.authMode} · actions ${data.app.dataDirWritable === false ? "n/a" : "per policy"}`}
              />
              <StatusRow
                label="/app/data writable"
                ok={data.app.dataDirWritable}
                detail={
                  data.app.dataVolumeFreeBytes !== null
                    ? `${(data.app.dataVolumeFreeBytes / 1024 ** 3).toFixed(1)} GiB free`
                    : "free space unknown"
                }
              />
            </CardContent>
          </Card>

          {/* Dependencies */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Dependencies</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <StatusRow
                label="Unraid API"
                ok={data.dependencies.unraid.reachable}
                detail={data.dependencies.unraid.reachable ? `${data.dependencies.unraid.latencyMs ?? "?"} ms` : "unreachable"}
              />
              <StatusRow
                label="Prometheus"
                ok={data.dependencies.prometheus.configured ? data.dependencies.prometheus.reachable : null}
                unknown={!data.dependencies.prometheus.configured}
                detail={
                  !data.dependencies.prometheus.configured
                    ? "not configured"
                    : data.dependencies.prometheus.reachable
                      ? `${data.dependencies.prometheus.latencyMs ?? "?"} ms`
                      : "unreachable"
                }
              />
              <StatusRow
                label="Update helper"
                ok={data.dependencies.helper.configured ? data.dependencies.helper.reachable : null}
                unknown={!data.dependencies.helper.configured}
                detail={
                  !data.dependencies.helper.configured
                    ? "not configured"
                    : data.dependencies.helper.reachable
                      ? `reachable · helper v${data.dependencies.helper.version ?? "?"}`
                      : (data.dependencies.helper.reason ?? "unreachable")
                }
              />
              <StatusRow
                label="GHCR (private pulls)"
                ok={data.ghcr.state === "ok" ? true : data.ghcr.state === "auth_required" ? false : null}
                unknown={data.ghcr.state === "unknown"}
                detail={
                  data.ghcr.state === "ok"
                    ? `pull probe OK${data.ghcr.latestTag ? ` · latest tag ${data.ghcr.latestTag}` : ""}`
                    : (data.ghcr.message ?? "state unknown")
                }
              />
            </CardContent>
          </Card>

          {/* Persistence */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <DatabaseBackup className="size-4 text-muted-foreground" aria-hidden /> Persistence
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <StatusRow
                label="Resilience backups"
                ok={data.persistence.backupsPresent > 0}
                detail={
                  data.persistence.latestBackup
                    ? `${data.persistence.backupsPresent} present · latest ${formatDateTimeIso(data.persistence.latestBackup.createdAt)}`
                    : "none yet — create one below"
                }
              />
              <StatusRow
                label="Rollback image"
                ok={data.updates.rollbackImage.imageId ? true : null}
                detail={
                  data.updates.rollbackImage.imageId
                    ? `tag "${data.updates.rollbackImage.tag}" · running v${data.updates.rollbackImage.currentVersion ?? "?"} · local: ${(data.updates.rollbackImage.localVersions ?? []).slice(0, 3).join(", ") || "none"}`
                    : "current image unknown (helper offline)"
                }
              />
              <StatusRow
                label="Pilot auto-update"
                ok={true}
                detail={data.updates.pilotAutoEnabled ? "ENABLED (pilot allowlist)" : "disabled by design in v0.7.13"}
              />
            </CardContent>
          </Card>

          {/* Update history highlights */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Last update / rollback</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <StatusRow
                label="Latest successful update"
                ok={data.updates.latestSuccessful ? true : null}
                unknown={!data.updates.latestSuccessful}
                detail={
                  data.updates.latestSuccessful
                    ? `v${data.updates.latestSuccessful.toVersion} · ${formatDateTimeIso(data.updates.latestSuccessful.at)}${data.updates.latestSuccessful.usedLocalImage ? " (local image)" : ""}${data.updates.latestSuccessful.scope !== "self" ? ` · ${data.updates.latestSuccessful.scope}${data.updates.latestSuccessful.target ? ` ${data.updates.latestSuccessful.target}` : ""}` : ""}`
                    : "none recorded"
                }
              />
              <StatusRow
                label="Latest rollback"
                ok={null}
                unknown
                detail={
                  data.updates.latestRollback
                    ? `${data.updates.latestRollback.scope}${data.updates.latestRollback.target ? ` ${data.updates.latestRollback.target}` : ""} · ${formatDateTimeIso(data.updates.latestRollback.at)}`
                    : "none recorded"
                }
              />
            </CardContent>
          </Card>

          {/* Active / stale operations */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                {data.operations.active?.stale ? (
                  <AlertTriangle className="size-4 text-amber-500" aria-hidden />
                ) : (
                  <Activity className="size-4 text-muted-foreground" aria-hidden />
                )}
                Active operation
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              {data.operations.active ? (
                <StatusRow
                  label={`${data.operations.active.kind}${data.operations.active.target ? `: ${data.operations.active.target}` : ""}`}
                  ok={!data.operations.active.stale}
                  detail={`phase ${data.operations.active.phase} · started ${data.operations.active.startedAt ? formatDateTimeIso(data.operations.active.startedAt) : "?"}${data.operations.active.stale ? " · STALE" : ""}`}
                />
              ) : (
                <StatusRow label="No active operation" ok={true} detail="All machines idle." />
              )}
              {data.operations.staleCandidates.slice(0, 3).map((candidate) => (
                <StatusRow
                  key={candidate.job}
                  label={`Stale: ${candidate.job}`}
                  ok={false}
                  detail={`phase ${candidate.phase} · started ${candidate.startedAt ? formatDateTimeIso(candidate.startedAt) : "?"}`}
                />
              ))}
            </CardContent>
          </Card>

          {/* Recovery actions */}
          <Card className="md:col-span-2 xl:col-span-3">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4 text-muted-foreground" aria-hidden /> Safe recovery actions
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => runAction("backup-create")} disabled={busyAction !== null}>
                  <HardDriveDownload className="size-4" aria-hidden />
                  {busyAction === "backup-create" ? "Creating…" : "Create resilience backup"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => runAction("backup-validate")} disabled={busyAction !== null}>
                  <ShieldCheck className="size-4" aria-hidden />
                  {busyAction === "backup-validate" ? "Validating…" : "Validate latest backup"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => runAction("backup-dry-run")} disabled={busyAction !== null}>
                  <DatabaseBackup className="size-4" aria-hidden />
                  {busyAction === "backup-dry-run" ? "Analyzing…" : "Restore dry-run"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => runAction("retry-dependency-check")} disabled={busyAction !== null}>
                  <RefreshCw className="size-4" aria-hidden />
                  {busyAction === "retry-dependency-check" ? "Re-checking…" : "Retry dependency check"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => runAction("clear-stale-operation")}
                  disabled={busyAction !== null || (data.operations.staleCandidates.length === 0 && !data.operations.active?.stale)}
                >
                  <AlertTriangle className="size-4" aria-hidden />
                  {busyAction === "clear-stale-operation" ? "Clearing…" : "Clear stale pre-mutation operation"}
                </Button>
              </div>

              {actionError && (
                <p className="mt-3 break-words text-sm text-destructive" role="alert">
                  {actionError}
                </p>
              )}
              {lastResult?.ok && (
                <div className="mt-3 rounded-md border bg-muted/40 p-3 text-sm">
                  <div className="flex items-center gap-2 font-medium">
                    <CheckCircle2 className="size-4 text-emerald-500" aria-hidden />
                    {lastResult.action} completed
                  </div>
                  {lastResult.result?.file && (
                    <p className="mt-1 break-all text-xs text-muted-foreground">
                      {lastResult.action === "backup-create" ? "Created " : "Validated "}
                      <code>{lastResult.result.file}</code>
                      {lastResult.entries !== undefined ? ` · ${lastResult.entries} dashboards` : ""}
                      {lastResult.result.bytes ? ` · ${(lastResult.result.bytes / 1024).toFixed(1)} KiB` : ""}
                    </p>
                  )}
                  {lastResult.result?.dryRun && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Would restore {lastResult.result.dryRun.wouldRestoreDashboards} dashboard(s),{" "}
                      {lastResult.result.dryRun.updateHistoryLines} history line(s). {lastResult.result.dryRun.note}
                    </p>
                  )}
                  {lastResult.result?.note && <p className="mt-1 text-xs text-muted-foreground">{lastResult.result.note}</p>}
                  {lastResult.result?.cleared && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Cleared: {lastResult.result.cleared.join(", ") || "nothing"}
                      {lastResult.result.refused && lastResult.result.refused.length > 0
                        ? ` · refused: ${lastResult.result.refused.map((entry) => `${entry.job} (${entry.reason})`).join("; ")}`
                        : ""}
                    </p>
                  )}
                </div>
              )}
              {lastResult && !lastResult.ok && !actionError && (
                <p className="mt-3 text-sm text-muted-foreground">{lastResult.reason ?? "Action reported failure."}</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      <p className="mt-4 text-xs text-muted-foreground">
        Status generated {formatDateTimeIso(data?.generatedAt ?? new Date().toISOString())}. Recovery actions are
        audited (kind <code>recovery</code>). Deliberately absent: generic shell, arbitrary restore, arbitrary image
        rollback.
      </p>
      <div className="mt-2">
        <Badge variant="outline" className="text-[10px]">
          v0.7.13
        </Badge>
      </div>
    </div>
  );
}
