"use client";

import { Download, RefreshCw, TriangleAlert, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePwa } from "./pwa-provider";
import { cn } from "@/lib/utils";

/**
 * Global connectivity/PWA banner. Rendered inside the app shell on every
 * page (NOC renders its own inline status):
 * - offline: blocking banner — writes are disabled, data labeled stale
 * - SW update ready: subtle, user-initiated refresh (never auto-reloads)
 */
export function PwaStatusBanner() {
  const { online, updateReady, applyUpdate } = usePwa();

  if (online && !updateReady) return null;

  return (
    <div
      role={online ? "status" : "alert"}
      className={cn(
        "sticky z-40 flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-medium",
        online
          ? "top-14 border-b border-warning/30 bg-warning/15 text-warning"
          : "top-14 border-b border-destructive/40 bg-destructive/15 text-destructive",
      )}
    >
      {online ? (
        <>
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Update ready — refresh to apply
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={applyUpdate}
          >
            Refresh
          </Button>
        </>
      ) : (
        <>
          <TriangleAlert className="size-3.5" aria-hidden="true" />
          Offline — showing last known state. Server data unavailable; lifecycle actions disabled.
        </>
      )}
    </div>
  );
}

/** Settings/About install hint: quiet, factual, only what the browser supports. */
export function InstallHint() {
  const { install, promptInstall, standalone, sw } = usePwa();

  if (standalone) {
    return (
      <p className="text-xs text-muted-foreground">
        Running as an installed app (standalone mode).
        {sw === "ready" ? " Background updates enabled." : ""}
      </p>
    );
  }

  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      {install === "prompt-available" && (
        <div className="flex items-center gap-2">
          <Download className="size-3.5" aria-hidden="true" />
          <span>This browser can install the dashboard as an app.</span>
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={promptInstall ?? undefined}>
            Install
          </Button>
        </div>
      )}
      {install === "ios" && (
        <p>
          Install on iOS: Share → <strong>Add to Home Screen</strong>. The dashboard then runs
          full-screen without browser chrome.
        </p>
      )}
      {install === "desktop-unsupported" && (
        <p>
          This browser does not offer an install prompt (Chrome/Edge/Safari 17+ do). The site is
          still installable via the browser menu where supported.
        </p>
      )}
      {install === "unsupported" && (
        <p>Installability is unavailable in this browser (no service worker / manifest support).</p>
      )}
    </div>
  );
}

/** Compact offline pill for headers where the full banner does not fit (NOC). */
export function OfflinePill() {
  const { online } = usePwa();
  if (online) return null;
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] font-medium text-destructive">
      <WifiOff className="size-3" aria-hidden="true" /> offline
    </span>
  );
}
