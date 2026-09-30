"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  PlayCircle,
  ScrollText,
  Square,
  XCircle,
} from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import {
  HISTORY_INTERVAL_MS,
  PAGE_INTERVAL_MS,
  type HistoryWindowPref,
} from "@/lib/prefs";
import { SectionStatus, MetricStatus } from "@/components/dashboard/section-status";
import { SeriesChart } from "@/components/dashboard/series-chart";
import { WindowPicker } from "@/components/dashboard/window-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/actions/confirm-dialog";
import { useDockerAction } from "@/components/actions/use-docker-action";
import { cn, formatBytes, formatDateTimeIso, formatPercent, formatRate } from "@/lib/utils";
import type {
  ContainerDetailPayload,
  ContainerHistoryPayload,
  DockerSummary,
  HistoryPoint,
  Section,
} from "@/lib/api-types";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-1.5 last:border-0">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm font-medium" title={typeof value === "string" ? value : undefined}>
        {value}
      </dd>
    </div>
  );
}

/**
 * Container detail page v2: state + metrics dominate; lifecycle actions
 * live in their own clearly separated section and always require an
 * explicit confirmation.
 */
export default function ContainerDetailPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(params.name);
  const [historyWindow, setHistoryWindow] = useState<HistoryWindowPref>("1h");
  const [showLabels, setShowLabels] = useState(false);

  const detail = usePoll<Section<ContainerDetailPayload | null>>(
    `/api/docker/detail?name=${encodeURIComponent(name)}`,
    PAGE_INTERVAL_MS.docker,
  );
  const docker = usePoll<Section<DockerSummary>>("/api/docker", PAGE_INTERVAL_MS.docker);
  const history = usePoll<ContainerHistoryPayload>(
    `/api/docker/history?name=${encodeURIComponent(name)}&window=${historyWindow}`,
    HISTORY_INTERVAL_MS[historyWindow],
  );
  // v0.9.10: the shared verified-action controller — identical semantics
  // to the Docker list cards (confirm → request → SSE/poll → timeout).
  const dockerAction = useDockerAction();

  const summary = useMemo(
    () => docker.data?.data?.containers.find((container) => container.name === name) ?? null,
    [docker.data, name],
  );
  const detailData = detail.data?.data ?? null;
  const metrics = summary?.metrics ?? null;
  const actionsEnabled = dockerAction.caps?.docker.enabled ?? false;

  const state = summary?.state ?? detailData?.state ?? null;
  const isRunning = state === "RUNNING";

  const historySeries = (points: HistoryPoint[]) =>
    points.length > 0 ? [{ name, points }] : [];


  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label="Back to containers">
          <Link href="/docker">
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{name}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {detailData?.image ?? summary?.image ?? "…"}
            {detailData?.composeProject ? ` · ${detailData.composeProject}` : ""}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {summary && (
            <Badge variant={isRunning ? "success" : state === "PAUSED" ? "warning" : "muted"}>
              {(state ?? "unknown").toLowerCase()}
            </Badge>
          )}
          <SectionStatus section={detail.data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }} compact />
        </div>
      </div>

      {detail.data?.data === null && detail.data?.status === "live" && (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
          Container not found in the live inventory. It may have been removed or renamed.
        </p>
      )}

      {/* Metrics ------------------------------------------------------- */}
      <section aria-label="Current metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="gap-0 p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">CPU</p>
          <p className="mt-1 font-mono text-xl tabular-nums">{formatPercent(metrics?.cpuPercent)}</p>
        </Card>
        <Card className="gap-0 p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Memory</p>
          <p className="mt-1 font-mono text-xl tabular-nums">{formatBytes(metrics?.memoryUsedBytes)}</p>
          <p className="text-[11px] text-muted-foreground">
            {metrics?.hasMemoryLimit && metrics.memoryPercentOfLimit !== null
              ? `${Math.round(metrics.memoryPercentOfLimit)}% of limit`
              : metrics
                ? "no limit"
                : "—"}
          </p>
        </Card>
        <Card className="gap-0 p-4">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Health</p>
          <p className="mt-1 text-xl">
            {summary?.health ? (
              <Badge variant={summary.health === "healthy" ? "success" : summary.health === "unhealthy" ? "destructive" : "warning"}>
                {summary.health}
              </Badge>
            ) : (
              <span className="text-sm text-muted-foreground">n/a</span>
            )}
          </p>
        </Card>
          <Card className="gap-0 p-4">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Update</p>
            <p className="mt-1 text-xl">
              {summary?.updateAvailable ? (
                <Badge variant="warning">available</Badge>
              ) : (
                <span className="text-sm text-muted-foreground">up to date</span>
              )}
            </p>
          </Card>
        </section>

        {/* Current network rates (v0.7): per-container via cAdvisor; the
            reliable=false case is labelled honestly instead of guessed. */}
        <section aria-label="Current network" className="grid grid-cols-2 gap-4">
          <Card className="gap-0 p-4">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Net RX now</p>
            <p className="mt-1 font-mono text-xl tabular-nums">
              {metrics?.networkReliable ? formatRate(metrics.networkRxBytesPerSec) : "—"}
            </p>
            {metrics?.networkReliable === false && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">host-network container — not attributable</p>
            )}
          </Card>
          <Card className="gap-0 p-4">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Net TX now</p>
            <p className="mt-1 font-mono text-xl tabular-nums">
              {metrics?.networkReliable ? formatRate(metrics.networkTxBytesPerSec) : "—"}
            </p>
          </Card>
        </section>

      {/* History charts -------------------------------------------------- */}
      <section aria-label="Metric history">
        <Card>
          <CardHeader className="gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="mr-auto text-base">History</CardTitle>
              <WindowPicker
                value={historyWindow}
                onChange={setHistoryWindow}
                options={["5m", "15m", "1h", "6h", "24h"] as HistoryWindowPref[]}
              />
            </div>
            <MetricStatus meta={history.data?.meta ?? null} />
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">CPU %</p>
              <SeriesChart
                series={historySeries(history.data?.cpu ?? [])}
                unit="percent"
                height={150}
                unavailable={history.data?.meta.status === "unavailable"}
                unavailableReason="History unavailable — Prometheus unreachable."
              />
            </div>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Memory</p>
              <SeriesChart
                series={historySeries(history.data?.memoryBytes ?? [])}
                unit="bytes"
                height={150}
                unavailable={history.data?.meta.status === "unavailable"}
              />
            </div>
            {history.data?.network ? (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Network (container interfaces)</p>
                <SeriesChart
                  series={[
                    { name: "RX", points: history.data.network.rx },
                    { name: "TX", points: history.data.network.tx },
                  ]}
                  unit="rate"
                  height={150}
                  unavailable={history.data.meta.status === "unavailable"}
                />
              </div>
            ) : (
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Network</p>
                <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                  {metrics?.networkReliable === false
                    ? "Not available for host-networked containers — their traffic is counted at interface level on the Network page."
                    : "Per-container network history unavailable."}
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Configuration ------------------------------------------------- */}
        <section aria-label="Configuration" className="min-w-0">
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="text-base">Configuration</CardTitle>
            </CardHeader>
            <CardContent>
              {detailData ? (
                <dl>
                  <Row label="State" value={(detailData.state ?? "—").toLowerCase()} />
                  <Row label="Docker status" value={detailData.status || "—"} />
                  <Row label="Autostart" value={detailData.autoStart ? "Enabled" : "Disabled"} />
                  <Row label="Created" value={formatDateTimeIso(detailData.createdEpochSeconds ? new Date(detailData.createdEpochSeconds * 1000).toISOString() : null)} />
                  <Row label="Command" value={detailData.command ?? "—"} />
                  <Row
                    label="Ports"
                    value={
                      detailData.ports.length > 0
                        ? detailData.ports
                            .slice(0, 6)
                            .map((port) => (port.publicPort != null ? `${port.publicPort}→${port.privatePort}` : `${port.privatePort}`))
                            .join(", ")
                        : "—"
                    }
                  />
                  <Row
                    label="Networks"
                    value={
                      detailData.networks.length > 0
                        ? detailData.networks
                            .map((network) => `${network.name}${network.ip ? ` (${network.ip})` : ""}`)
                            .join(", ")
                        : "—"
                    }
                  />
                  <Row label="Mounts" value={detailData.mounts.length > 0 ? `${detailData.mounts.length} mount(s)` : "—"} />
                  {detailData.webUiUrl && (
                    <Row
                      label="Web UI"
                      value={
                        <a href={detailData.webUiUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 underline-offset-2 hover:underline">
                          open <ExternalLink className="size-3" aria-hidden="true" />
                        </a>
                      }
                    />
                  )}
                </dl>
              ) : (
                <Skeleton className="h-40 w-full" />
              )}
              {detailData && detailData.mounts.length > 0 && (
                <div className="mt-3 overflow-x-auto rounded-md border">
                  <table className="w-full min-w-[380px] text-xs">
                    <caption className="sr-only">Mounts</caption>
                    <thead>
                      <tr className="border-b text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                        <th scope="col" className="px-2.5 py-1.5 font-medium">Host path</th>
                        <th scope="col" className="px-2.5 py-1.5 font-medium">Container path</th>
                        <th scope="col" className="px-2.5 py-1.5 font-medium">RW</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detailData.mounts.map((mount, index) => (
                        <tr key={`${mount.source}-${mount.destination}-${index}`} className="border-b last:border-0">
                          <td className="max-w-[200px] truncate px-2.5 py-1.5 font-mono" title={mount.source ?? ""}>
                            {mount.source ?? "—"}
                          </td>
                          <td className="max-w-[160px] truncate px-2.5 py-1.5 font-mono" title={mount.destination ?? ""}>
                            {mount.destination ?? "—"}
                          </td>
                          <td className="px-2.5 py-1.5">{mount.rw === null ? "—" : mount.rw ? "rw" : "ro"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </section>

        {/* Labels + logs + events ---------------------------------------- */}
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <button
                type="button"
                className="flex w-full items-center justify-between"
                onClick={() => setShowLabels((value) => !value)}
                aria-expanded={showLabels}
              >
                <CardTitle className="text-base">Labels</CardTitle>
                {showLabels ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
              </button>
            </CardHeader>
            {showLabels && (
              <CardContent>
                {detailData && Object.keys(detailData.labels).length > 0 ? (
                  <dl className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                    {Object.entries(detailData.labels).map(([key, value]) => (
                      <div key={key} className="grid grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-2 text-xs">
                        <dt className="truncate font-mono text-muted-foreground" title={key}>{key}</dt>
                        <dd className="truncate font-mono" title={value}>{value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="text-xs text-muted-foreground">No labels.</p>
                )}
              </CardContent>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ScrollText className="size-4 text-muted-foreground" aria-hidden="true" />
                Logs
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                Container logs are not available through the safe read-only API
                (the Unraid log API exposes system log files only, and this
                dashboard intentionally has no Docker socket access). System
                logs remain available on the{" "}
                <Link href="/logs" className="underline underline-offset-2">Logs page</Link>.
              </p>
            </CardContent>
          </Card>

          <RecentEvents name={name} />
        </div>
      </div>

      {/* Actions --------------------------------------------------------- */}
      <section aria-label="Lifecycle actions">
        <Card className={cn(!actionsEnabled && "opacity-80")}>
          <CardHeader>
            <CardTitle className="text-base">Actions</CardTitle>
            {!actionsEnabled && dockerAction.caps?.reason && (
              <p className="text-xs text-muted-foreground">{dockerAction.caps.reason}</p>
            )}
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                disabled={!actionsEnabled || isRunning || dockerAction.posting || !summary}
                onClick={() => summary && dockerAction.begin({ id: summary.id, name: summary.name, action: "start" })}
              >
                <PlayCircle aria-hidden="true" /> Start
              </Button>
              {/* restart is intentionally absent: the live Unraid API (v4.10.0)
                  does not expose docker.restart — only verified actions ship. */}
              <Button
                variant="destructive"
                size="sm"
                disabled={!actionsEnabled || !isRunning || dockerAction.posting || !summary}
                onClick={() => summary && dockerAction.begin({ id: summary.id, name: summary.name, action: "stop" })}
              >
                <Square aria-hidden="true" /> Stop
              </Button>
              {dockerAction.phase && (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 text-xs",
                    dockerAction.phase.timedOut ? "text-warning" : "text-muted-foreground",
                  )}
                  role="status"
                >
                  <span className="size-2 animate-pulse rounded-full bg-warning" aria-hidden="true" />
                  {dockerAction.phase.label}
                </span>
              )}
            </div>
            {dockerAction.result && (
              <p
                role={dockerAction.result.ok ? "status" : "alert"}
                className={cn(
                  "mt-3 flex items-start gap-1.5 text-xs",
                  dockerAction.result.ok ? "text-success" : "text-destructive",
                )}
              >
                {dockerAction.result.ok ? (
                  <CheckCircle2 className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                )}
                {dockerAction.result.message}
                {dockerAction.result.ok && dockerAction.result.via
                  ? ` (confirmed via ${dockerAction.result.via === "sse" ? "live event" : "state poll"})`
                  : ""}
              </p>
            )}
            <p className="mt-3 text-[11px] text-muted-foreground">
              Read-only monitoring is unaffected by action failures. Delete,
              recreate and exec are intentionally unavailable. Every action is
              confirmed, logged to the audit trail, and subject to cooldowns.
            </p>
          </CardContent>
        </Card>
      </section>

      {/* Confirmations ---------------------------------------------------- */}
      {/* Shared confirmation (v0.9.10): one controller, same semantics as
          the Docker list cards. Restart intentionally absent — the live
          Unraid API exposes start/stop/pause/unpause only. */}
      <ConfirmDialog
        open={dockerAction.pendingConfirm !== null}
        title={
          dockerAction.pendingConfirm
            ? `${dockerAction.pendingConfirm.action === "stop" ? "Stop" : "Start"} ${dockerAction.pendingConfirm.name}?`
            : ""
        }
        severity={dockerAction.pendingConfirm?.action === "stop" ? "destructive" : "info"}
        confirmLabel={dockerAction.pendingConfirm?.action === "stop" ? "Stop container" : "Start container"}
        busy={dockerAction.posting}
        onCancel={dockerAction.cancel}
        onConfirm={() => dockerAction.confirm()}
      >
        {dockerAction.pendingConfirm?.action === "stop" ? (
          <>
            <p>
              The container <strong>{name}</strong> is currently running.
            </p>
            <p>
              Stopping makes its service <strong>unavailable</strong> until started again. Anything that depends on it (including
              other containers in the same compose project) may fail.
            </p>
          </>
        ) : (
          <p>Will bring the container from stopped to running state.</p>
        )}
      </ConfirmDialog>

    </div>
  );
}

/* Recent lifecycle events from the audit trail (dashboard actions only). */

function RecentEvents({ name }: { name: string }) {
  const audit = usePoll<{ entries: Array<{ id: string; timestamp: string; action: string; result: string; targetName: string; actor: string }> }>(
    "/api/audit?limit=100",
    30_000,
  );
  const transitions = usePoll<{ transitions: Array<{ name: string; from: string; to: string; at: string }> }>(
    "/api/events/transitions",
    30_000,
  );

  type Row = { key: string; at: string; label: string; source: string; result: string };
  const rows: Row[] = [
    ...(audit.data?.entries ?? [])
      .filter((entry) => entry.targetName === name)
      .map((entry) => ({
        key: entry.id,
        at: entry.timestamp,
        label: entry.action,
        source: "Dashboard action",
        result: entry.result,
      })),
    ...(transitions.data?.transitions ?? [])
      .filter((entry) => entry.name === name)
      .map((entry) => ({
        key: `obs-${entry.at}-${entry.to}`,
        at: entry.at,
        label: `observed: ${entry.from.toLowerCase()} → ${entry.to.toLowerCase()}`,
        source: "Observed state change",
        result: "observed",
      })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Recent events</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No events recorded yet. Dashboard-triggered actions and observed
            state changes (sampled every 10s) appear here.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {rows.map((row) => (
              <li key={row.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
                <span className="font-mono text-muted-foreground">
                  {formatDateTimeIso(row.at)}
                </span>
                <span className="font-medium">{row.label}</span>
                <Badge
                  variant={
                    row.source === "Dashboard action"
                      ? row.result === "success"
                        ? "success"
                        : row.result === "rejected"
                          ? "warning"
                          : "destructive"
                      : "secondary"
                  }
                >
                  {row.source}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
