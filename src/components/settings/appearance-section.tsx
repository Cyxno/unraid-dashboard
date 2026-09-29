"use client";

import { Bot, Check, Monitor, Moon, Palette, Sun, Sparkles } from "lucide-react";
import { useAppearance, BUILT_IN_THEMES, ACCENTS, type ThemeChoice } from "@/lib/appearance";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Settings → Appearance (v0.9.0): theme, accent, density, motion. Every
 * change applies instantly via data-attributes (live preview, no reload)
 * and persists per-browser. Pure UI preference — no server config here.
 */

const THEME_LABELS: Record<Exclude<ThemeChoice, "system">, string> = {
  dark: "Beacon Dark",
  light: "Light",
  midnight: "Midnight",
  graphite: "Graphite",
  ocean: "Ocean",
  forest: "Forest",
  amber: "Amber",
  slate: "Slate",
};

/** Small live preview tile rendered with the ACTUAL theme applied locally. */
function ThemeSwatch({ theme, label }: { theme: string; label: string }) {
  const palette: Record<string, { bg: string; surface: string; accent: string; text: string }> = {
    dark: { bg: "#161619", surface: "#222226", accent: "oklch(72% 0.13 155)", text: "#e6e6ea" },
    light: { bg: "#f5f5f7", surface: "#ffffff", accent: "oklch(52% 0.12 155)", text: "#2a2a30" },
    midnight: { bg: "#12141f", surface: "#191c2b", accent: "oklch(75% 0.11 215)", text: "#e4e6f0" },
    graphite: { bg: "#151517", surface: "#1e1e21", accent: "#a3a3ad", text: "#e8e8ea" },
    ocean: { bg: "#0f1c22", surface: "#15262e", accent: "oklch(72% 0.12 200)", text: "#dfeef2" },
    forest: { bg: "#0f1d16", surface: "#15281e", accent: "oklch(72% 0.13 145)", text: "#e0efe6" },
    amber: { bg: "#1e1913", surface: "#2a231a", accent: "oklch(78% 0.13 70)", text: "#f0e8dc" },
    slate: { bg: "#171a20", surface: "#20242c", accent: "oklch(70% 0.1 250)", text: "#e4e7ee" },
  };
  const paletteEntry = palette[theme] ?? palette.dark!;
  return (
    <div
      className="overflow-hidden rounded-lg border"
      style={{ background: paletteEntry.bg }}
      aria-hidden="true"
    >
      <div className="flex gap-1 p-1.5">
        <div className="h-8 w-8 rounded-md" style={{ background: paletteEntry.surface }} />
        <div className="flex-1 space-y-1 py-0.5">
          <div className="h-1.5 w-4/5 rounded" style={{ background: paletteEntry.text, opacity: 0.75 }} />
          <div className="h-1.5 w-3/5 rounded" style={{ background: paletteEntry.text, opacity: 0.35 }} />
          <div className="h-1.5 w-2/5 rounded" style={{ background: paletteEntry.accent }} />
        </div>
      </div>
      <p className="pb-1.5 text-center text-[10px] text-muted-foreground">{label}</p>
    </div>
  );
}

const ACCENT_SWATCH: Record<string, string> = {
  emerald: "oklch(0.72 0.13 155)",
  blue: "oklch(0.66 0.13 250)",
  violet: "oklch(0.66 0.15 300)",
  cyan: "oklch(0.75 0.11 215)",
  rose: "oklch(0.66 0.16 15)",
  amber: "oklch(0.78 0.13 70)",
};

export function AppearanceSection() {
  const { appearance, resolvedTheme, systemDark, set, reset } = useAppearance();

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Palette className="size-4 text-muted-foreground" aria-hidden />
          Appearance
          <Badge variant="outline" className="text-[10px]">
            per-browser
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5 pt-0">
        {/* Theme */}
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Theme</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
            <button
              type="button"
              onClick={() => set({ theme: "system" })}
              aria-pressed={appearance.theme === "system"}
              className={cn(
                "rounded-lg border p-2 text-left transition-colors",
                appearance.theme === "system" ? "border-primary ring-1 ring-primary" : "hover:border-muted-foreground/40",
              )}
            >
              <div className="flex items-center gap-1.5 pb-1 text-xs font-medium">
                {systemDark ? <Moon className="size-3.5" aria-hidden /> : <Sun className="size-3.5" aria-hidden />}
                System
              </div>
              <ThemeSwatch theme={systemDark ? "dark" : "light"} label={`→ ${resolvedTheme}`} />
            </button>
            {BUILT_IN_THEMES.map((theme) => (
              <button
                key={theme}
                type="button"
                onClick={() => set({ theme })}
                aria-pressed={appearance.theme === theme}
                className={cn(
                  "rounded-lg border p-2 text-left transition-colors",
                  appearance.theme === theme ? "border-primary ring-1 ring-primary" : "hover:border-muted-foreground/40",
                )}
              >
                <div className="flex items-center gap-1.5 pb-1 text-xs font-medium">
                  {appearance.theme === theme && <Check className="size-3.5 text-primary" aria-hidden />}
                  {THEME_LABELS[theme]}
                </div>
                <ThemeSwatch theme={theme} label={THEME_LABELS[theme]} />
              </button>
            ))}
          </div>
        </div>

        {/* Accent */}
        <div>
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            <Sparkles className="size-3.5" aria-hidden /> Accent
          </p>
          <div className="flex flex-wrap gap-2">
            {ACCENTS.filter((accent) => accent !== "custom").map((accent) => (
              <button
                key={accent}
                type="button"
                aria-pressed={appearance.accent === accent}
                aria-label={`Accent ${accent}`}
                onClick={() => set({ accent })}
                className={cn(
                  "size-8 rounded-full border-2 transition-transform",
                  appearance.accent === accent ? "scale-110 border-foreground" : "border-transparent hover:scale-105",
                )}
                style={{ background: ACCENT_SWATCH[accent] }}
              />
            ))}
            <label
              className={cn(
                "flex size-8 cursor-pointer items-center justify-center rounded-full border-2 text-xs font-semibold",
                appearance.accent === "custom" ? "border-foreground" : "border-dashed border-muted-foreground/50",
              )}
              title="Custom accent color"
            >
              <Palette className="size-3.5" aria-hidden />
              <input
                type="color"
                className="sr-only"
                value={appearance.accentHex ?? "#22c55e"}
                onChange={(event) => {
                  const value = event.target.value;
                  if (/^#[0-9a-fA-F]{6}$/.test(value)) set({ accent: "custom", accentHex: value });
                }}
              />
            </label>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Accents recolor highlights and charts only — status colors (success/warning/danger) are never altered.
          </p>
        </div>

        {/* Density + motion */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Density</p>
            <div className="flex gap-2" role="group" aria-label="Density">
              {(["comfortable", "compact"] as const).map((density) => (
                <Button
                  key={density}
                  size="sm"
                  variant={appearance.density === density ? "default" : "outline"}
                  className="capitalize"
                  aria-pressed={appearance.density === density}
                  onClick={() => set({ density })}
                >
                  {density}
                </Button>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Animations</p>
            <div className="flex gap-2" role="group" aria-label="Animations">
              {(["full", "reduced"] as const).map((motion) => (
                <Button
                  key={motion}
                  size="sm"
                  variant={appearance.motion === motion ? "default" : "outline"}
                  className="capitalize"
                  aria-pressed={appearance.motion === motion}
                  onClick={() => set({ motion })}
                >
                  {motion === "full" ? (
                    <Monitor className="size-3.5" aria-hidden />
                  ) : (
                    <Bot className="size-3.5" aria-hidden />
                  )}
                  {motion}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Saved per browser. Current theme: <span className="font-medium text-foreground">{resolvedTheme}</span>.
          </p>
          <Button size="sm" variant="ghost" onClick={reset}>
            Reset to defaults
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
