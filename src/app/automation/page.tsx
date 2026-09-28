"use client";

import { useCallback, useState } from "react";
import {
  Bot,
  CheckCircle2,
  CircleDashed,
  Clock,
  Layers,
  OctagonPause,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { PageHeader, LoadingPanel, ErrorPanel } from "@/components/dashboard/page-primitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn, formatDateTimeIso } from "@/lib/utils";

/**
 * Automation page (v0.8.0): the pilot-auto control plane. Mobile-first.
 * Global enable/pause, maintenance window, age delay, cooldowns, per-
 * container opt-ins with visible reasons, the durable queue, and the
 * event feed. The server re-derives every verdict — the UI only edits
 * operator intent.
 */

interface AutomationTarget {
  name: string;
  state: string;
  reasons: string[];
  optIn: boolean;
  risk: string;
  managementType: string;
  healthcheckPresent: boolean;
  snapshotPresent: boolean;
  registryVerified: boolean;
  updateAvailable: boolean;
  remoteDigest: string | null;
  digestAgeHours: number | null;
  manualSuccesses: number;
  rollbackCount: number;
  cooldownUntil: string | null;
  cooldownReason: string | null;
  interventionRequired: boolean;
  interventionReason: string | null;
  pipelineOwned: boolean;
}

interface AutomationStatus {
  policyVersion: string;
  enabled: boolean;
  paused: boolean;
  config: {
    maintenance: { enabled: boolean; days: number[]; startHour: number; endHour: number; timezone: string };
    minUpdateAgeHours: number;
    maxPerWindow: number;
    cooldownHours: number;
  };
  scheduler: { lastTickAt: string | null; intervalMs: number };
  window: { inWindow: boolean; reason: string };
  targets: AutomationTarget[];
  queue: Array<{ id: string; target: string; scope: string; image: string; digest: string | null; reasons: string[]; state: string; createdAt: string }>;
  events: Array<{ id: string; at: string; kind: string; target: string | null; message: string }>;
  projects: { count: number; changedConfigs: number; pipelineOwned: number; lastPollAt: string | null; stale: boolean };
  infrastructure: { helperHealthy: boolean | null; dataDirWritable: boolean; operationActive: boolean };
}

const STATE_VARIANT: Record<string, "success" | "warning" | "destructive" | "muted" | "secondary"> = {
  eligible: "success",
  queued: "success",
  updating: "success",
  verifying: "success",
  completed: "success",
  delayed_by_age: "warning",
  outside_window: "secondary",
  cooldown: "warning",
  rolled_back: "destructive",
  intervention_required: "destructive",
  blocked: "muted",
  waiting: "muted",
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function AutomationPage() {
  const status = usePoll<AutomationStatus>("/api/automation", 15_000);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAllTargets, setShowAllTargets] = useState(false);

  const act = useCallback(
    async (body: Record<string, unknown>, key: string) => {
      setBusy(key);
      setError(null);
      try {
        const response = await fetch("/api/automation/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) setError(payload.error ?? `Action failed (HTTP ${response.status}).`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Action failed.");
      } finally {
        setBusy(null);
        status.refresh();
      }
    },
    [status],
  );

  const postConfig = useCallback(
    async (patch: Record<string, unknown>, key: string) => {
      setBusy(key);
      setError(null);
      try {
        const response = await fetch("/api/automation/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
        });
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) setError(payload.error ?? `Config change failed (HTTP ${response.status}).`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Config change failed.");
      } finally {
        setBusy(null);
        status.refresh();
      }
    },
    [status],
  );

  const data = status.data;
  const targets = data?.targets ?? [];
  const relevant = targets.filter((target) => target.optIn || target.state !== "blocked");
  const visible = showAllTargets ? relevant : relevant.slice(0, 8);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <PageHeader
        title="Automation"
        description="Pilot auto-updates for a tiny proven-safe allowlist. The server re-derives every verdict; this UI edits operator intent only."
        actions={
          <Button variant="outline" size="sm" onClick={status.refresh} disabled={status.loading}>
            <RefreshCw className={cn("size-4", status.loading && "animate-spin")} aria-hidden /> Refresh
          </Button>
        }
      />

      {status.error && !data && <ErrorPanel message={status.error} />}
      {!data && !status.error && <LoadingPanel rows={6} />}

      {data && (
        <div className="space-y-4">
          {/* Global control */}
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Bot className="size-4 text-muted-foreground" aria-hidden /> Pilot auto-update
                <Badge variant={data.enabled ? (data.paused ? "warning" : "success") : "muted"}>
                  {data.paused ? "PAUSED" : data.enabled ? "ENABLED" : "DISABLED"}
                </Badge>
                <Badge variant="outline" className="text-[10px]">
                  {data.policyVersion}
                </Badge>
              </CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant={data.enabled ? "destructive" : "default"}
                  disabled={busy !== null}
                  onClick={() => postConfig({ enabled: !data.enabled }, "enable")}
                >
                  <PlayCircle className="size-4" aria-hidden />
                  {data.enabled ? "Disable automation" : "Enable automation"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null || !data.enabled}
                  onClick={() => postConfig({ paused: !data.paused }, "pause")}
                >
                  <OctagonPause className="size-4" aria-hidden />
                  {data.paused ? "Resume" : "Pause automation"}
                </Button>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act({ action: "run-once" }, "runonce")}>
                  <RefreshCw className={cn("size-4", busy === "runonce" && "animate-spin")} aria-hidden />
                  Evaluate now
                </Button>
              </div>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid gap-x-6 gap-y-1 text-xs text-muted-foreground sm:grid-cols-2">
                <span className="flex items-center gap-1.5">
                  <Clock className="size-3.5" aria-hidden />
                  Window:{" "}
                  {data.config.maintenance.enabled ? (
                    <>
                      {data.config.maintenance.days.map((day) => DAY_LABELS[day]).join(",")} ·{" "}
                      {String(data.config.maintenance.startHour).padStart(2, "0")}:00–
                      {String(data.config.maintenance.endHour).padStart(2, "0")}:00 {data.config.maintenance.timezone} ·{" "}
                      <Badge variant={data.window.inWindow ? "success" : "secondary"} className="text-[10px]">
                        {data.window.inWindow ? "open" : "closed"}
                      </Badge>
                    </>
                  ) : (
                    "always open (window disabled)"
                  )}
                </span>
                <span>Min digest age: {data.config.minUpdateAgeHours}h · max {data.config.maxPerWindow} per window · cooldown {data.config.cooldownHours}h</span>
                <span>
                  Scheduler: {data.scheduler.lastTickAt ? `last tick ${formatDateTimeIso(data.scheduler.lastTickAt)}` : "no tick yet"} (every {Math.round(data.scheduler.intervalMs / 1000)}s)
                </span>
                <span>
                  Infra: helper {data.infrastructure.helperHealthy === true ? "healthy" : "unavailable"} · /app/data{" "}
                  {data.infrastructure.dataDirWritable ? "writable" : "NOT writable"} · window used {data.queue.length} queued
                </span>
              </div>
              {error && (
                <p className="mt-2 text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}
              {data.infrastructure.dataDirWritable === false && (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-warning">
                  <ShieldAlert className="size-3.5" aria-hidden /> /app/data is not writable — automation is blocked until persistence recovers.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Queue */}
          {data.queue.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Layers className="size-4 text-muted-foreground" aria-hidden /> Queue
                  <Badge variant="secondary" className="text-[10px]">
                    {data.queue.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 pt-0">
                {data.queue.map((job) => (
                  <div key={job.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5 text-xs">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{job.target}</span>
                        <Badge variant={STATE_VARIANT[job.state] ?? "secondary"} className="text-[10px]">
                          {job.state}
                        </Badge>
                      </div>
                      <p className="mt-0.5 truncate text-muted-foreground">
                        {job.image} · {job.digest?.slice(7, 19)} · queued {formatDateTimeIso(job.createdAt)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      disabled={busy !== null || job.state !== "queued"}
                      onClick={() => act({ action: "cancel", id: job.id }, `cancel-${job.id}`)}
                    >
                      Cancel
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* Targets */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-base">Targets &amp; eligibility</CardTitle>
              {relevant.length > 8 && (
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowAllTargets((value) => !value)}>
                  {showAllTargets ? "Show less" : `Show all ${relevant.length}`}
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-2 pt-0">
              {visible.length === 0 && <p className="text-sm text-muted-foreground">No opt-in targets yet — opt in below once a container has a proven track record.</p>}
              {visible.map((target) => (
                <div key={target.name} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{target.name}</span>
                      <Badge variant={STATE_VARIANT[target.state] ?? "secondary"} className="text-[10px]">
                        {target.state.replace(/_/g, " ")}
                      </Badge>
                      {target.risk !== "LOW" && <Badge variant="destructive" className="text-[10px]">{target.risk}</Badge>}
                      {target.pipelineOwned && <Badge variant="warning" className="text-[10px]">pipeline</Badge>}
                    </div>
                    {target.interventionRequired || target.cooldownUntil ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs"
                        disabled={busy !== null}
                        onClick={() => act({ action: "ack", name: target.name }, `ack-${target.name}`)}
                      >
                        Acknowledge
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant={target.optIn ? "destructive" : "outline"}
                        className="h-7 text-xs"
                        disabled={busy !== null || target.pipelineOwned}
                        onClick={() => act({ action: "opt-in", name: target.name, optIn: !target.optIn }, `opt-${target.name}`)}
                      >
                        {target.optIn ? "Opt out" : "Opt in"}
                      </Button>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                    <span>track record: {target.manualSuccesses} success / {target.rollbackCount} rollback</span>
                    <span>healthcheck: {target.healthcheckPresent ? "yes" : "no"} · snapshot: {target.snapshotPresent ? "yes" : "no"}</span>
                    <span>registry: {target.registryVerified ? "verified" : "unreadable"} · digest age: {target.digestAgeHours === null ? "—" : `${target.digestAgeHours}h`}</span>
                    <span>adapter: {target.managementType}/{target.managementType === "compose" ? "mature" : "generic"}</span>
                  </div>
                  {(target.reasons.length > 0 || target.interventionRequired) && (
                    <ul className="mt-1.5 space-y-0.5">
                      {target.interventionRequired && target.interventionReason && (
                        <li className="flex items-start gap-1.5 text-xs text-destructive">
                          <XCircle className="mt-0.5 size-3 shrink-0" aria-hidden /> {target.interventionReason}
                        </li>
                      )}
                      {target.reasons.map((reason) => (
                        <li key={reason} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                          <CircleDashed className="mt-0.5 size-3 shrink-0" aria-hidden /> {reason}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Projects summary */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Compose projects (registry)</CardTitle>
            </CardHeader>
            <CardContent className="pt-0 text-xs text-muted-foreground">
              <p>
                {data.projects.count} tracked · {data.projects.changedConfigs} changed config(s) · {data.projects.pipelineOwned} pipeline-owned ·
                last poll {data.projects.lastPollAt ? formatDateTimeIso(data.projects.lastPollAt) : "never"}
                {data.projects.stale ? " (stale)" : ""}
              </p>
              <p className="mt-1">Project-level automation stays manual-only in v0.8.0; the registry invalidates plans when configs change.</p>
            </CardContent>
          </Card>

          {/* Events */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Automation events</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 pt-0">
              {data.events.length === 0 && <p className="text-sm text-muted-foreground">No automation events yet.</p>}
              {data.events.slice(0, 12).map((event) => (
                <div key={event.id} className="flex items-start gap-2 text-xs">
                  {event.kind === "auto_update_completed" ? (
                    <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
                  ) : event.kind === "auto_update_rolled_back" || event.kind === "intervention_required" ? (
                    <XCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-hidden />
                  ) : (
                    <CircleDashed className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className="min-w-0">
                    <span className="text-muted-foreground">{formatDateTimeIso(event.at)} · </span>
                    {event.message}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
