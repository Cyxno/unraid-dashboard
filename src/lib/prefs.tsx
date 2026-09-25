"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

/**
 * Dashboard-local UI preferences persisted in localStorage.
 * No sensitive values ever live here.
 */

export type TempUnit = "C" | "F";
export type RefreshPreset = "fast" | "normal" | "relaxed";
export type Density = "compact" | "comfortable";
export type HistoryWindowPref = "5m" | "15m" | "1h" | "6h" | "24h" | "7d";

export interface Prefs {
  refresh: RefreshPreset;
  tempUnit: TempUnit;
  density: Density;
  showVirtualIfaces: boolean;
  historyWindow: HistoryWindowPref;
  /** Per-core CPU grid on the System page. */
  showPerCore: boolean;
  /** Compact metric columns on the Docker page. */
  dockerMetrics: boolean;
  /** Overview widget order (ids of the six summary cards). */
  overviewOrder: string[];
  /** User-saved views: named snapshots of display prefs. */
  savedViews: Record<string, SavedView>;
}

/** A saved view snapshots the display prefs it covers (never secrets). */
export interface SavedView {
  refresh: RefreshPreset;
  tempUnit: TempUnit;
  density: Density;
  historyWindow: HistoryWindowPref;
  showPerCore: boolean;
  dockerMetrics: boolean;
  overviewOrder: string[];
}

export const DEFAULT_OVERVIEW_ORDER = [
  "cpu",
  "memory",
  "uptime",
  "array",
  "network",
  "docker",
] as const;

/** Built-in view presets; NOC is a navigation shortcut, not a pref set. */
export const BUILT_IN_VIEWS: Record<string, () => Partial<SavedView>> = {
  Default: () => ({}),
  "Docker-heavy": () => ({ dockerMetrics: true, density: "compact", historyWindow: "1h" }),
  "Storage-heavy": () => ({ historyWindow: "24h", density: "compact" }),
  Thermal: () => ({ tempUnit: "C", showPerCore: true, historyWindow: "6h" }),
  Network: () => ({ historyWindow: "15m" }),
};

export const REFRESH_INTERVAL_MS: Record<RefreshPreset, number> = {
  fast: 3_000,
  normal: 5_000,
  relaxed: 10_000,
};

/**
 * History-window refetch cadence. Long windows are expensive server-side
 * (they hit Prometheus range queries that are themselves cached) and
 * useless when refreshed every few seconds.
 */
export const HISTORY_INTERVAL_MS: Record<HistoryWindowPref, number> = {
  "5m": 10_000,
  "15m": 15_000,
  "1h": 30_000,
  "6h": 60_000,
  "24h": 120_000,
  "7d": 300_000,
};

/** Per-page poll cadences (server-side TTL caches make this cheap). */
export const PAGE_INTERVAL_MS = {
  overview: 5_000,
  docker: 10_000,
  storage: 20_000,
  network: 10_000,
  system: 30_000,
  vms: 30_000,
  notifications: 20_000,
  logs: 30_000,
  connection: 15_000,
  /** Instant Prometheus snapshots (server caches ~3s). */
  systemMetrics: 4_000,
} as const;

const DEFAULTS: Prefs = {
  refresh: "normal",
  tempUnit: "C",
  density: "comfortable",
  showVirtualIfaces: false,
  historyWindow: "15m",
  showPerCore: true,
  dockerMetrics: true,
  overviewOrder: [...DEFAULT_OVERVIEW_ORDER],
  savedViews: {},
};

const STORAGE_KEY = "unraid-dashboard.prefs.v1";

interface PrefsContextValue {
  prefs: Prefs;
  setPref: <K extends keyof Prefs>(key: K, value: Prefs[K]) => void;
  reset: () => void;
}

const PrefsContext = createContext<PrefsContextValue | null>(null);

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);

  useEffect(() => {
    // localStorage is read post-hydration on purpose: reading it during
    // render would diverge from the SSR output and cause hydration errors.
    try {

      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<Prefs>;
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setPrefs((current) => ({ ...current, ...parsed }));
      }
    } catch {
      // Corrupted preferences fall back to defaults.
    }
  }, []);

  const setPref = useCallback(
    <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
      setPrefs((current) => {
        const next = { ...current, [key]: value };
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Storage unavailable (private mode) — in-memory only.
        }
        return next;
      });
    },
    [],
  );

  const reset = useCallback(() => {
    setPrefs(DEFAULTS);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo(() => ({ prefs, setPref, reset }), [prefs, setPref, reset]);
  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsContextValue {
  const context = useContext(PrefsContext);
  if (!context) throw new Error("usePrefs must be used within PrefsProvider");
  return context;
}
