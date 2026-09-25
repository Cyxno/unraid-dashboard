"use client";

import { createContext, useContext } from "react";
import { usePoll, type PollResult } from "@/hooks/use-poll";
import { usePrefs, REFRESH_INTERVAL_MS } from "@/lib/prefs";
import type { OverviewPayload } from "@/lib/api-types";

const OverviewContext = createContext<PollResult<OverviewPayload> | null>(null);

/**
 * Shared polling state for the overview payload so the header, health
 * banner and overview page render one consistent snapshot.
 */
export function OverviewProvider({ children }: { children: React.ReactNode }) {
  const { prefs } = usePrefs();
  const result = usePoll<OverviewPayload>(
    `/api/overview?window=${prefs.historyWindow}`,
    REFRESH_INTERVAL_MS[prefs.refresh],
  );
  return <OverviewContext.Provider value={result}>{children}</OverviewContext.Provider>;
}

export function useOverview(): PollResult<OverviewPayload> {
  const context = useContext(OverviewContext);
  if (!context) {
    throw new Error("useOverview must be used within OverviewProvider");
  }
  return context;
}
