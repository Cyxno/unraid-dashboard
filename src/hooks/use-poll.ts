"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePwa } from "@/components/layout/pwa-provider";


export interface PollResult<T> {
  /** Latest payload — retained across failures (stale-tolerant). */
  data: T | null;
  loading: boolean;
  /** Set when the last fetch failed. Data may still be present (stale). */
  error: string | null;
  /** True once at least one fetch succeeded. */
  ready: boolean;
  /** When the data was last successfully fetched (epoch ms), if ever. */
  updatedAt: number | null;
  refresh: () => void;
}

/**
 * Polls a dashboard API endpoint without reloading. On failure the last
 * successful payload is retained (the server marks it stale) and only the
 * error flag flips — the UI never blanks out during a transient outage.
 *
 * While the browser is offline the interval keeps ticking but requests are
 * skipped (no pointless retries); the moment connectivity returns a single
 * refresh fires immediately so "stale" panels recover without waiting a
 * full interval.
 */
export function usePoll<T>(url: string, intervalMs: number): PollResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);
  const { online } = usePwa();

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;

    const run = async () => {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`Request failed (HTTP ${response.status})`);
        }
        const payload = (await response.json()) as T;
        if (cancelled) return;
        setData(payload);
        setUpdatedAt(Date.now());
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Request failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    const timer = setInterval(() => {
      if (navigator.onLine) run();
    }, Math.max(2000, intervalMs));

    // Recover instantly when connectivity returns.
    const onOnline = () => {
      if (!cancelled) run();
    };
    window.addEventListener("online", onOnline);

    return () => {
      cancelled = true;
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [url, intervalMs, tick]);

  // Expose the paused state through the error message so callers can
  // distinguish "offline, not retrying" from a real request failure.
  useEffect(() => {
    if (mounted.current && !online && updatedAt !== null) {
      setError((current) => current ?? "Offline — showing last known data");
    }
  }, [online, updatedAt]);

  return { data, loading, error, ready: updatedAt !== null, updatedAt, refresh };
}
