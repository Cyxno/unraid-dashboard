"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, TriangleAlert, WifiOff, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePwa } from "./pwa-provider";
import { useLive } from "./live-events";
import { isAnyBusyScope } from "@/lib/busy-guard";
import { cn } from "@/lib/utils";

/**
 * Global connectivity/PWA banners, rendered inside the app shell on every
 * page (NOC renders its own inline status):
 * - offline: blocking banner — writes disabled, data labelled stale
 * - dashboard update in progress: maintenance banner (SSE-driven)
 * - backend version ahead of the browser bundle: restrained "newer
 *   dashboard version available" banner with a guarded refresh
 * - service-worker update ready: user-initiated refresh (never auto)
 * Refresh actions are refused while a mutation, dialog or update is busy.
 */

const VERSION_CHECK_MS = 300_000;

/** Backend version vs the version baked into this browser bundle. */
function useVersionMismatch(): { mismatch: boolean; serverVersion: string | null } {
  const [serverVersion, setServerVersion] = useState<string | null>(null);

  const check = useCallback(async () => {
    try {
      const response = await fetch("/api/version", { cache: "no-store" });
      if (!response.ok) return;
      const body = (await response.json()) as { version?: string };
      if (body.version) setServerVersion(body.version);
    } catch {
      // unreachable — keep the last known value
    }
  }, []);

  useEffect(() => {
    // Initial version fetch (async — setState happens post-await).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void check();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, VERSION_CHECK_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  // The bundle's build-time version (inlined by next.config env).
  const bundleVersion = process.env.APP_VERSION_FALLBACK ?? null;
  const mismatch =
    Boolean(serverVersion) &&
    Boolean(bundleVersion) &&
    bundleVersion !== "unknown" &&
    serverVersion !== bundleVersion;
  return { mismatch, serverVersion };
}

function guardRefresh(action: () => void): void {
  // Never refresh mid-mutation, mid-dialog or mid-update.
  if (isAnyBusyScope()) return;
  action();
}

function BannerRow({
  tone,
  icon: Icon,
  children,
  pulse = false,
}: {
  tone: "warning" | "destructive";
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean | "true" }>;
  children: React.ReactNode;
  pulse?: boolean;
}) {
  return (
    <div
      className={cn(
        "sticky top-14 z-40 flex items-center justify-center gap-2 border-b px-4 py-1.5 text-xs font-medium",
        tone === "destructive"
          ? "border-destructive/40 bg-destructive/15 text-destructive"
          : "border-warning/30 bg-warning/15 text-warning",
      )}
    >
      <Icon className={cn("size-3.5", pulse && "animate-pulse")} aria-hidden={true} />
      {children}
    </div>
  );
}

/** All static banners (offline / version mismatch / SW update ready). */
export function PwaStatusBanner() {
  const { online, updateReady, applyUpdate } = usePwa();
  const { mismatch } = useVersionMismatch();

  if (!online && !mismatch && !updateReady) {
    return (
      <BannerRow tone="destructive" icon={TriangleAlert}>
        Offline — showing last known state. Server data unavailable; lifecycle actions disabled.
      </BannerRow>
    );
  }
  if (online && !mismatch && !updateReady) return null;

  return (
    <>
      {!online && (
        <BannerRow tone="destructive" icon={TriangleAlert}>
          Offline — showing last known state. Server data unavailable; lifecycle actions disabled.
        </BannerRow>
      )}
      {online && mismatch && (
        <BannerRow tone="warning" icon={RefreshCw}>
          A newer dashboard version is available
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => guardRefresh(() => window.location.reload())}
          >
            Refresh
          </Button>
        </BannerRow>
      )}
      {online && updateReady && (
        <BannerRow tone="warning" icon={RefreshCw}>
          Update ready — refresh to apply
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-[11px]"
            onClick={() => guardRefresh(applyUpdate)}
          >
            Refresh
          </Button>
        </BannerRow>
      )}
    </>
  );
}

/** Maintenance banner while an in-app dashboard update machine runs. */
export function UpdateMaintenanceBanner() {
  const { updatePhase } = useLive();
  const active = Boolean(
    updatePhase &&
      updatePhase.phase !== "idle" &&
      updatePhase.phase !== "complete" &&
      updatePhase.phase !== "failed",
  );
  if (!active || !updatePhase) return null;
  return (
    <BannerRow tone="warning" icon={Wrench} pulse>
      Dashboard update in progress — {updatePhase.phase}
      {updatePhase.detail ? `: ${updatePhase.detail}` : ""}. Lifecycle actions are disabled until it completes.
    </BannerRow>
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
