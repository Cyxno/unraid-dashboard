"use client";

import { useState } from "react";
import { Menu, RefreshCw } from "lucide-react";
import { ViewsMenu } from "./views-menu";
import { AuthIndicator } from "./auth-indicator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, formatUptime, humanState } from "@/lib/utils";
import type {
  HealthLevel,
  HealthSummary,
  Section,
  SystemIdentity,
} from "@/lib/api-types";
import type { PollResult } from "@/hooks/use-poll";
import type { OverviewPayload } from "@/lib/api-types";

interface HeaderProps {
  overview: PollResult<OverviewPayload>;
  onMenuClick: () => void;
}

const HEALTH_META: Record<
  Exclude<HealthLevel, null>,
  { label: string; className: string }
> = {
  healthy: { label: "Healthy", className: "border-success/30 bg-success/10 text-success" },
  attention: { label: "Attention", className: "border-warning/30 bg-warning/10 text-warning" },
  critical: { label: "Critical", className: "border-destructive/30 bg-destructive/10 text-destructive" },
};

function healthBadge(health: HealthSummary | undefined, hasData: boolean) {
  if (!hasData) return null;
  const level = health?.level ?? null;
  if (!level) {
    return <Badge variant="muted">Unknown state</Badge>;
  }
  const meta = HEALTH_META[level];
  return (
    <span
      title={health?.reasons.join(" · ") || undefined}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        meta.className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-1.5 rounded-full",
          level === "healthy" && "bg-success",
          level === "attention" && "bg-warning animate-pulse",
          level === "critical" && "bg-destructive animate-pulse",
        )}
      />
      {meta.label}
    </span>
  );
}

function dataStatusBadge(overview: PollResult<OverviewPayload>) {
  const anyDemo = hasDemo(overview.data);
  if (overview.error && !overview.data) {
    return <Badge variant="destructive">Offline</Badge>;
  }
  if (anyDemo) return <Badge variant="warning">Demo data</Badge>;
  if (overview.error) return <Badge variant="warning">Degraded</Badge>;
  if (overview.data) return <Badge variant="success">Live</Badge>;
  return null;
}

function hasDemo(payload: OverviewPayload | null): boolean {
  if (!payload) return false;
  const sections = [
    payload.identity,
    payload.cpu,
    payload.memory,
    payload.storage,
    payload.docker,
    payload.network,
    payload.notifications,
  ];
  return sections.some((section) => section?.status === "demo");
}

export function Header({ overview, onMenuClick }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const payload = overview.data;
  const identity: Section<SystemIdentity> | undefined = payload?.identity;
  const storage = payload?.storage;

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur-sm supports-[backdrop-filter]:bg-background/80">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Open navigation"
        aria-expanded={menuOpen}
        onClick={() => {
          setMenuOpen(true);
          onMenuClick();
        }}
      >
        <Menu aria-hidden="true" />
      </Button>

      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="truncate text-sm font-semibold">
          {identity?.data?.serverName ?? "Unraid server"}
        </h1>
        {identity?.data?.osVersion && (
          <Badge variant="muted" className="hidden sm:inline-flex">
            v{identity.data.osVersion}
          </Badge>
        )}
        {storage?.data && (
          <Badge
            variant={storage.data.state === "STARTED" ? "muted" : "warning"}
            className="hidden md:inline-flex"
          >
            Array {humanState(storage.data.state)}
          </Badge>
        )}
        {identity?.data?.uptimeSeconds != null && (
          <span className="hidden text-xs text-muted-foreground lg:inline">
            up {formatUptime(identity.data.uptimeSeconds)}
          </span>
        )}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {healthBadge(payload?.health, Boolean(payload))}
        {dataStatusBadge(overview)}
        <AuthIndicator />
        <ViewsMenu />
        <Button
          variant="ghost"
          size="icon"
          onClick={overview.refresh}
          disabled={overview.loading}
          aria-label="Refresh data"
        >
          <RefreshCw className={cn(overview.loading && "animate-spin")} aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}
