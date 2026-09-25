"use client";

import { createContext, useContext } from "react";
import { useOverview } from "@/hooks/use-overview";
import type { OverviewSnapshot, ResourceSample, Sourced } from "@/server/unraid/types";

interface OverviewContextValue {
  snapshot: Sourced<OverviewSnapshot> | null;
  error: string | null;
  loading: boolean;
  history: ResourceSample[];
  refresh: () => void;
}

const OverviewContext = createContext<OverviewContextValue | null>(null);

/** Shared polling state so the header and pages render the same data. */
export function OverviewProvider({ children }: { children: React.ReactNode }) {
  const { snapshot, error, loading, history, refresh } = useOverview();
  return (
    <OverviewContext.Provider
      value={{ snapshot, error, loading, history, refresh }}
    >
      {children}
    </OverviewContext.Provider>
  );
}

export function useOverviewContext(): OverviewContextValue {
  const context = useContext(OverviewContext);
  if (!context) {
    throw new Error("useOverviewContext must be used within OverviewProvider");
  }
  return context;
}
