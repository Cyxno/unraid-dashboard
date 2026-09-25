/**
 * History windows served from Prometheus range queries. Step sizes are
 * chosen so charts get ~30–170 points regardless of window: fine-grained
 * for short windows, coarse for long ones. This keeps payloads small
 * (a few KB) and chart rendering cheap.
 */

export type HistoryWindow = "5m" | "15m" | "1h" | "6h" | "24h" | "7d";

export const HISTORY_WINDOWS: HistoryWindow[] = [
  "5m",
  "15m",
  "1h",
  "6h",
  "24h",
  "7d",
];

export const WINDOW_MS: Record<HistoryWindow, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

export const WINDOW_SECONDS: Record<HistoryWindow, number> = {
  "5m": 5 * 60,
  "15m": 15 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "24h": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
};

/** Prometheus range-query step per window. */
export const WINDOW_STEP_SECONDS: Record<HistoryWindow, number> = {
  "5m": 10,
  "15m": 30,
  "1h": 60,
  "6h": 240,
  "24h": 600,
  "7d": 3600,
};

/**
 * Counter `rate()` window for a range query. Must be at least 2× the
 * scrape interval (15s) and at least the range step so every point has
 * samples to rate over.
 */
export function rateWindowSeconds(window: HistoryWindow): number {
  const step = WINDOW_STEP_SECONDS[window];
  const doubled = step * 2;
  if (doubled <= 60) return 60;
  // Round up to a multiple of the scrape interval for stable rates.
  return Math.ceil(doubled / 15) * 15;
}

/** Parse + validate an untrusted window parameter. */
export function parseWindow(
  value: string | null | undefined,
  fallback: HistoryWindow = "15m",
): HistoryWindow {
  return value && (HISTORY_WINDOWS as string[]).includes(value)
    ? (value as HistoryWindow)
    : fallback;
}

/**
 * Cache TTL per window: short windows stay near-live, long windows are
 * expensive and refetched rarely (a 7-day range query is never useful
 * more than once every several minutes).
 */
export const WINDOW_CACHE_TTL_MS: Record<HistoryWindow, number> = {
  "5m": 5_000,
  "15m": 15_000,
  "1h": 30_000,
  "6h": 60_000,
  "24h": 120_000,
  "7d": 300_000,
};
