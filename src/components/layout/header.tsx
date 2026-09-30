"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
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

/** Health badge with an explanation popover (v0.9.9): tapping explains
 *  WHY (ranked reasons) instead of leaving users to hunt across pages. */
function HealthBadge({ health, hasData }: { health: HealthSummary | undefined; hasData: boolean }) {
  const [open, setOpen] = useState(false);
  if (!hasData) return null;
  const level = health?.level ?? null;
  if (!level) {
    return <Badge variant="muted">Unknown state</Badge>;
  }
  const meta = HEALTH_META[level];
  const reasons = health?.reasons ?? [];
  // v0.9.9: the badge is a button — tapping it explains WHY (ranked
  // reasons) instead of leaving users to hunt across pages. Desktop
  // keeps the hover title.
  return (
    <span className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${meta.label} — show reasons`}
        title={reasons.join(" · ") || undefined}
        onClick={() => setOpen((value) => !value)}
        onBlur={(event) => {
          if (!event.currentTarget.closest("span")?.contains(event.relatedTarget as Node)) setOpen(false);
        }}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
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
      </button>
      {open && reasons.length > 0 && (
        <div
          role="dialog"
          aria-label={`Health: ${meta.label}`}
          className="absolute right-0 top-8 z-50 max-h-[70vh] w-72 overflow-y-auto rounded-lg border bg-card p-3 text-xs shadow-xl"
        >
          <p className="mb-1.5 flex items-center gap-1.5 font-semibold">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                level === "healthy" && "bg-success",
                level === "attention" && "bg-warning",
                level === "critical" && "bg-destructive",
              )}
            />
            {meta.label}
            {level !== "healthy" && " — why:"}
          </p>
          <ul className="space-y-1 text-muted-foreground">
            {reasons.map((reason) => (
              <li key={reason} className="flex gap-1.5">
                <span aria-hidden="true" className="text-muted-foreground/60">
                  •
                </span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
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
  // Views are an Overview-composition feature (v0.9.5): the saved/shared
  // view controls only apply there, not on section pages.
  const pathname = usePathname();
  const showViews = pathname === "/";
  const payload = overview.data;
  const identity: Section<SystemIdentity> | undefined = payload?.identity;
  const storage = payload?.storage;

  return (
    <header className="safe-top sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur-sm supports-[backdrop-filter]:bg-background/80">
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
            className="hidden lg:inline-flex"
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
        <HealthBadge health={payload?.health} hasData={Boolean(payload)} />
        {/* Data status is redundant with the health badge on phones; the
            health badge stays visible at every width (v0.9.5 topbar rule). */}
        <span className="hidden sm:inline-flex">{dataStatusBadge(overview)}</span>
        <AuthIndicator />
        {showViews && <ViewsMenu />}
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
