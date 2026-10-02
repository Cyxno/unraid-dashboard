"use client";

import { Activity, Boxes, Server } from "lucide-react";
import { BeaconMark } from "@/components/brand/logo";
import { StatusDot, type StatusTone } from "@/components/ui/status";
import { cn, formatUptime } from "@/lib/utils";

/**
 * Overview hero (v0.9.0): server identity + overall verdict + the two
 * numbers an operator glances at first (uptime, containers). One wide
 * card with deliberately larger type than the metric grid below — the
 * top of the visual hierarchy, not another equal card.
 */

export interface HeroStripProps {
  serverName: string | null;
  osVersion: string | null;
  uptimeSeconds: number | null;
  healthLevel: string | null;
  healthReasons: string[];
  containersRunning: number | null;
  containersTotal: number | null;
}

function healthTone(level: string | null): StatusTone {
  switch (level) {
    case "healthy":
      return "healthy";
    case "attention":
      return "warning";
    case "critical":
      return "critical";
    default:
      return "offline";
  }
}

export function HeroStrip({
  serverName,
  osVersion,
  uptimeSeconds,
  healthLevel,
  healthReasons,
  containersRunning,
  containersTotal,
}: HeroStripProps) {
  const tone = healthTone(healthLevel);
  const verdict =
    healthLevel === "healthy"
      ? "All systems nominal"
      : healthLevel === "attention"
        ? "Needs attention"
        : healthLevel === "critical"
          ? "Critical condition"
          : "State unknown";
  return (
    <section
      aria-label="Server overview"
      className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-card sm:flex-row sm:items-center"
    >
      <BeaconMark className="size-12 rounded-xl" />
      <div className="min-w-0 flex-1">
        <h2 className="flex items-center gap-2 truncate text-lg font-semibold tracking-tight">
          {serverName ?? "Unraid server"}
          <span className="flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-normal text-muted-foreground">
            <StatusDot tone={tone} pulse={tone !== "healthy" && tone !== "offline"} />
            {verdict}
          </span>
        </h2>
        <p className="mt-0.5 truncate text-sm text-muted-foreground">
          {osVersion ? `Unraid OS v${osVersion}` : "Unraid OS"}
          {healthReasons.length > 0 ? ` · ${healthReasons.slice(0, 2).join(" · ")}` : ""}
        </p>
      </div>
      <dl className="flex shrink-0 gap-6">
        <div>
          <dt className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            <Activity className="size-3" aria-hidden /> Uptime
          </dt>
          <dd className="tnum text-xl font-semibold">
            {uptimeSeconds !== null ? formatUptime(uptimeSeconds) : "—"}
          </dd>
        </div>
        <div>
          <dt className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            <Boxes className="size-3" aria-hidden /> Containers
          </dt>
          <dd className={cn("tnum text-xl font-semibold")}>
            {containersRunning !== null ? `${containersRunning}` : "—"}
            {containersTotal !== null && (
              <span className="text-sm font-normal text-muted-foreground">/{containersTotal}</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}

export function HeroStripSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-4 rounded-xl border bg-card p-5 sm:flex-row sm:items-center">
      <div className="size-12 rounded-xl bg-muted" />
      <div className="min-w-0 flex-1 space-y-2">
        <Server className="size-4 text-muted" aria-hidden />
        <div className="h-4 w-40 rounded bg-muted" />
        <div className="h-3 w-56 rounded bg-muted" />
      </div>
      <div className="flex gap-6">
        <div className="h-10 w-20 rounded bg-muted" />
        <div className="h-10 w-20 rounded bg-muted" />
      </div>
    </div>
  );
}
