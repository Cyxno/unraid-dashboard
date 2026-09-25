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
export type HistoryWindowPref = "5m" | "15m" | "1h";

export interface Prefs {
  refresh: RefreshPreset;
  tempUnit: TempUnit;
  density: Density;
  showVirtualIfaces: boolean;
  historyWindow: HistoryWindowPref;
}

export const REFRESH_INTERVAL_MS: Record<RefreshPreset, number> = {
  fast: 3_000,
  normal: 5_000,
  relaxed: 10_000,
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
} as const;

const DEFAULTS: Prefs = {
  refresh: "normal",
  tempUnit: "C",
  density: "comfortable",
  showVirtualIfaces: false,
  historyWindow: "15m",
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
