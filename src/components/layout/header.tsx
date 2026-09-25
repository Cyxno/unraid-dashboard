"use client";

import { useState } from "react";
import { Menu, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatUptime } from "@/lib/utils";
import type { OverviewSnapshot, Sourced } from "@/server/unraid/types";

interface HeaderProps {
  snapshot: Sourced<OverviewSnapshot> | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onMenuClick: () => void;
}

export function Header({ snapshot, loading, error, onRefresh, onMenuClick }: HeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const identity = snapshot?.data.identity;
  const online = snapshot?.status === "live" && !error;

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
        <span
          aria-hidden="true"
          className={cn(
            "flex size-2 shrink-0 rounded-full",
            online ? "bg-success" : "bg-warning animate-pulse",
          )}
        />
        <h1 className="truncate text-sm font-semibold">
          {identity?.serverName ?? "Unraid server"}
        </h1>
        {identity?.osVersion && (
          <Badge variant="muted" className="hidden sm:inline-flex">
            v{identity.osVersion}
          </Badge>
        )}
        {identity?.uptimeSeconds != null && (
          <span className="hidden text-xs text-muted-foreground lg:inline">
            up {formatUptime(identity.uptimeSeconds)}
          </span>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {error ? (
          <Badge variant="destructive">Connection error</Badge>
        ) : snapshot?.status === "live" ? (
          <Badge variant="success">
            <Server aria-hidden="true" /> Live
          </Badge>
        ) : snapshot ? (
          <Badge variant="warning">Demo data</Badge>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh data"
        >
          <RefreshCw className={cn(loading && "animate-spin")} aria-hidden="true" />
        </Button>
      </div>
    </header>
  );
}
