"use client";

import { useState } from "react";
import { Sidebar } from "./sidebar";
import { Header } from "./header";
import { OverviewProvider, useOverviewContext } from "./overview-provider";

function Shell({ children }: { children: React.ReactNode }) {
  const [navOpen, setNavOpen] = useState(false);
  const { snapshot, error, loading, refresh } = useOverviewContext();

  return (
    <div className="min-h-svh">
      <Sidebar open={navOpen} onClose={() => setNavOpen(false)} />
      <div className="md:pl-60">
        <Header
          snapshot={snapshot}
          loading={loading}
          error={error}
          onRefresh={refresh}
          onMenuClick={() => setNavOpen(true)}
        />
        <main className="mx-auto w-full max-w-7xl p-4 sm:p-6">{children}</main>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <OverviewProvider>
      <Shell>{children}</Shell>
    </OverviewProvider>
  );
}
