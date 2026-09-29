"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Beacon appearance preferences (v0.9.0): theme, accent, density, motion.
 *
 * Persisted per-browser in localStorage (`beacon.appearance.v1`) — UI
 * preference only, never secrets, never mixed with server config.
 * Applied as data-attributes on <html>; the actual colors live entirely
 * in globals.css token sets, so switching is a variable swap (no reload).
 *
 * A pre-paint inline script in layout.tsx applies the stored attributes
 * before first paint, so there is no theme flash on navigation/reload.
 */

export const BUILT_IN_THEMES = ["dark", "light", "midnight", "graphite", "ocean", "forest", "amber", "slate"] as const;
export const ACCENTS = ["emerald", "blue", "violet", "cyan", "rose", "amber", "custom"] as const;

export type ThemeChoice = (typeof BUILT_IN_THEMES)[number] | "system";
export type AccentChoice = (typeof ACCENTS)[number];
export type DensityChoice = "comfortable" | "compact";
export type MotionChoice = "full" | "reduced";

export interface Appearance {
  theme: ThemeChoice;
  accent: AccentChoice;
  /** Custom accent hex (#rrggbb) when accent === "custom". */
  accentHex: string | null;
  density: DensityChoice;
  motion: MotionChoice;
}

export const DEFAULT_APPEARANCE: Appearance = {
  theme: "dark",
  accent: "emerald",
  accentHex: null,
  density: "comfortable",
  motion: "full",
};

const STORAGE_KEY = "beacon.appearance.v1";
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Validates + migrates any stored payload; unknown/invalid → defaults. */
export function normalizeAppearance(input: unknown): Appearance {
  if (typeof input !== "object" || input === null) return { ...DEFAULT_APPEARANCE };
  const raw = input as Record<string, unknown>;
  const theme = BUILT_IN_THEMES.includes(raw.theme as (typeof BUILT_IN_THEMES)[number]) || raw.theme === "system"
    ? (raw.theme as ThemeChoice)
    : DEFAULT_APPEARANCE.theme;
  const accent = ACCENTS.includes(raw.accent as AccentChoice) ? (raw.accent as AccentChoice) : DEFAULT_APPEARANCE.accent;
  const accentHex = typeof raw.accentHex === "string" && HEX_RE.test(raw.accentHex) ? raw.accentHex : null;
  const density = raw.density === "compact" ? "compact" : "comfortable";
  const motion = raw.motion === "reduced" ? "reduced" : "full";
  return { theme, accent, accentHex: accent === "custom" ? (accentHex ?? "#22c55e") : null, density, motion };
}

export function loadAppearance(): Appearance {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return normalizeAppearance(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearance(appearance: Appearance): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // private mode / storage full — preferences stay session-only
  }
}

/** Resolves "system" against the OS preference; anything else passes through. */
export function resolveTheme(theme: ThemeChoice, systemDark: boolean): string {
  if (theme !== "system") return theme;
  return systemDark ? "dark" : "light";
}

/** Applies appearance as data-attributes + inline custom property on <html>. */
export function applyAppearance(appearance: Appearance, systemDark: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(appearance.theme, systemDark);
  if (appearance.accent === "custom" && appearance.accentHex) {
    root.dataset.accent = "custom";
    root.style.setProperty("--accent-custom", appearance.accentHex);
  } else {
    root.dataset.accent = appearance.accent;
    root.style.removeProperty("--accent-custom");
  }
  root.dataset.density = appearance.density;
  root.dataset.motion = appearance.motion;
}

interface AppearanceContextValue {
  appearance: Appearance;
  resolvedTheme: string;
  systemDark: boolean;
  set: (patch: Partial<Appearance>) => void;
  reset: () => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  // Lazy initializers read the persisted appearance synchronously so the
  // first render already carries the stored theme (no setState-in-effect).
  // SSR-safe lazy init: server renders defaults; on the client the first
  // render already carries the stored theme (the pre-paint script set the
  // data-attrs, so there is no flash and no setState-in-effect).
  const [appearance, setAppearance] = useState<Appearance>(() =>
    typeof window === "undefined" ? DEFAULT_APPEARANCE : loadAppearance(),
  );
  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window === "undefined" ? true : window.matchMedia("(prefers-color-scheme: dark)").matches,
  );

  // Mount: apply the stored appearance to the DOM (state itself is already
  // hydrated by the lazy initializers) + react to OS scheme changes.
  useEffect(() => {
    const stored = loadAppearance();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    applyAppearance(stored, media.matches);
    const onChange = (event: MediaQueryListEvent) => {
      setSystemDark(event.matches);
      applyAppearance(loadAppearance(), event.matches);
    };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const set = useCallback((patch: Partial<Appearance>) => {
    setAppearance((current) => {
      const next = normalizeAppearance({ ...current, ...patch });
      saveAppearance(next);
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      applyAppearance(next, media.matches);
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setAppearance((current) => {
      const next = { ...DEFAULT_APPEARANCE };
      saveAppearance(next);
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      applyAppearance(next, media.matches);
      return next;
    });
  }, []);

  const resolvedTheme = resolveTheme(appearance.theme, systemDark);
  const value = useMemo(
    () => ({ appearance, resolvedTheme, systemDark, set, reset }),
    [appearance, resolvedTheme, systemDark, set, reset],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error("useAppearance must be used within AppearanceProvider");
  return context;
}

/** Pre-paint snippet: apply stored appearance before first render (no flash). */
export const APPEARANCE_PREPAINT_SCRIPT = `(function(){try{var a=JSON.parse(localStorage.getItem("beacon.appearance.v1")||"null")||{};var t=a.theme;var themes=["dark","light","midnight","graphite","ocean","forest","amber","slate"];var d=document.documentElement;if(t==="system"){d.dataset.theme=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";}else if(themes.indexOf(t)>=0){d.dataset.theme=t;}if(a.accent){d.dataset.accent=a.accent;if(a.accent==="custom"&&a.accentHex){d.style.setProperty("--accent-custom",a.accentHex);}}if(a.density){d.dataset.density=a.density;}if(a.motion){d.dataset.motion=a.motion;}}catch(e){}})();`;
