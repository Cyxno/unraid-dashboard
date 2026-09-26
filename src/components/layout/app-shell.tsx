"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { OverviewProvider, useOverview } from "./overview-provider";
import { PrefsProvider } from "@/lib/prefs";
import { ToastProvider } from "./toast";
import { LiveEventsProvider } from "./live-events";
import { BottomNav } from "./bottom-nav";
import { PwaProvider } from "./pwa-provider";
import { PwaStatusBanner, UpdateMaintenanceBanner } from "./pwa-status-banner";
import { AuthExpiredOverlay } from "./auth-expired-overlay";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";

const COLLAPSE_KEY = "unraid-dashboard.sidebar.collapsed";

/** Fetches /api/version once; renders nothing on failure (dev or old build). */
function VersionFooter() {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/version", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((info: { version?: string } | null) => {
        if (!cancelled && info?.version) setVersion(info.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return version ? ` · v${version}` : null;
}

function Shell({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const overview = useOverview();
  const pathname = usePathname();
  useEffect(() => {
    // Read post-hydration on purpose to stay consistent with SSR output.
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // default expanded
    }
  }, []);

  // NOC mode is a standalone wallboard: no sidebar, header or footer.
  // (Hooks above run unconditionally — rules of hooks.)
  if (pathname === "/noc") {
    return <>{children}</>;
  }

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };

  return (
    <div className="min-h-svh">
      <Sidebar
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
      />
      <div
        className={cn(
          "transition-[padding] duration-200",
          collapsed ? "md:pl-14" : "md:pl-56",
        )}
      >
        <Header overview={overview} onMenuClick={() => setMobileNavOpen(true)} />
        <CommandPalette />
        {/* Offline / version-mismatch / SW-update banners, then the
            maintenance banner while an in-app update machine runs. */}
        <PwaStatusBanner />
        <UpdateMaintenanceBanner />
        {/* Full-screen sign-in state when the proxy session expires. */}
        <AuthExpiredOverlay />
        <main className="mx-auto w-full max-w-7xl p-3 pb-[calc(env(safe-area-inset-bottom)+4.75rem)] sm:p-6 md:pb-6">{children}</main>
        <footer className="mx-auto w-full max-w-7xl px-4 pb-6 sm:px-6">
          <p className="text-[11px] text-muted-foreground">
            History is served from Prometheus (7-day retention on this host);
            during Prometheus outages the overview chart falls back to an
            in-memory buffer that resets when the container restarts.
            <VersionFooter />
          </p>
        </footer>
        <BottomNav />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <PwaProvider>
      <PrefsProvider>
        <OverviewProvider>
          <ToastProvider>
            <LiveEventsProvider>
              <Shell>{children}</Shell>
            </LiveEventsProvider>
          </ToastProvider>
        </OverviewProvider>
      </PrefsProvider>
    </PwaProvider>
  );
}
