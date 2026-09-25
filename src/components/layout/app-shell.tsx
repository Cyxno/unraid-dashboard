"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { OverviewProvider, useOverview } from "./overview-provider";
import { PrefsProvider } from "@/lib/prefs";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "unraid-dashboard.sidebar.collapsed";

function Shell({ children }: { children: React.ReactNode }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const overview = useOverview();

  useEffect(() => {
    // Read post-hydration on purpose to stay consistent with SSR output.
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    } catch {
      // default expanded
    }
  }, []);

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
        <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">{children}</main>
        <footer className="mx-auto w-full max-w-7xl px-4 pb-6 sm:px-6">
          <p className="text-[11px] text-muted-foreground">
            Metrics history is tracked in dashboard process memory and resets when
            the container restarts.
          </p>
        </footer>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <PrefsProvider>
      <OverviewProvider>
        <Shell>{children}</Shell>
      </OverviewProvider>
    </PrefsProvider>
  );
}
