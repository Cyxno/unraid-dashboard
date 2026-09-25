"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { OverviewSnapshot, ResourceSample, Sourced } from "@/server/unraid/types";

export const HISTORY_LIMIT = 60;

interface OverviewState {
  snapshot: Sourced<OverviewSnapshot> | null;
  error: string | null;
  loading: boolean;
  history: ResourceSample[];
}

const INITIAL: OverviewState = {
  snapshot: null,
  error: null,
  loading: true,
  history: [],
};

/**
 * Polls the BFF overview endpoint and accumulates a rolling history of
 * resource samples for the chart. The Unraid API exposes point-in-time
 * metrics only, so history is built client-side per visit.
 */
export function useOverview(intervalMs = 10_000) {
  const [state, setState] = useState<OverviewState>(INITIAL);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/overview", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Request failed with HTTP ${response.status}`);
      }
      const snapshot = (await response.json()) as Sourced<OverviewSnapshot>;
      if (!mounted.current) return;
      setState((prev) => {
        const point: ResourceSample = {
          time: Date.now(),
          cpu: snapshot.data.cpu.percentTotal,
          memory: snapshot.data.memory.percentTotal,
          rx: snapshot.data.network.rxBytesPerSec,
          tx: snapshot.data.network.txBytesPerSec,
        };
        return {
          snapshot,
          error: null,
          loading: false,
          history: [...prev.history, point].slice(-HISTORY_LIMIT),
        };
      });
    } catch (error) {
      if (!mounted.current) return;
      setState((prev) => ({
        ...prev,
        loading: false,
        error:
          error instanceof Error ? error.message : "Failed to load overview.",
      }));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [refresh, intervalMs]);

  return { ...state, refresh };
}
