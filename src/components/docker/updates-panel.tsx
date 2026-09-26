"use client";

import { useMemo, useState } from "react";
import { ArrowUpCircle, RefreshCw, ShieldAlert } from "lucide-react";
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

export function DockerUpdatesPanel() {
  const { online } = usePwa();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const updates = usePoll<UpdatesPayload>("/api/docker/updates", 600_000);
  const data = updates.data;

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
                </li>
              ))}
            </ul>
            {interesting.length > 6 && (
              <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setShowAll((value) => !value)}>
                {showAll ? "Show less" : `Show all ${interesting.length}`}
              </Button>
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
