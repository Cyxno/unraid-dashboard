import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(path.join(repoRoot, "src/app/globals.css"), "utf8");

/**
 * Theme regression (v0.9.0): every built-in theme must define the full
 * token set, and the core text/surface pairs must pass WCAG AA contrast
 * (>= 4.5:1). "Pretty but unreadable" cannot ship.
 */

const THEMES: Array<{ name: string; block: string }> = (() => {
  const blocks: Array<{ name: string; block: string }> = [];
  // :root + [data-theme="dark"] share one block.
  const rootMatch = css.match(/:root,\n\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  if (rootMatch) blocks.push({ name: "dark", block: rootMatch[1]! });
  for (const match of css.matchAll(/^\[data-theme="([a-z]+)"\] \{([\s\S]*?)\n\}/gm)) {
    if (match[1] === "dark") continue;
    // First definition wins (the @layer color-scheme one-liner is excluded
    // by the line anchor, but dedupe defensively anyway).
    if (blocks.some((entry) => entry.name === match[1])) continue;
    blocks.push({ name: match[1]!, block: match[2]! });
  }
  return blocks;
})();

/** Extracts a raw var value from a theme block, following var() references. */
function valueOf(block: string, name: string): string | null {
  const match = block.match(new RegExp(`--${name}: ([^;]+);`));
  return match ? match[1]!.trim() : null;
}

function resolve(block: string, name: string, depth = 0): string | null {
  const raw = valueOf(block, name);
  if (raw === null) {
    // CSS var inheritance: unnamed tokens fall back to the :root block.
    const rootBlock = THEMES.find((entry) => entry.name === "dark")?.block ?? "";
    const inherited = valueOf(rootBlock, name);
    if (inherited === null) return null;
    const inheritedRef = inherited.match(/^var\(--([a-z-]+)\)$/);
    if (inheritedRef && depth < 4) return resolve(rootBlock, inheritedRef[1]!, depth + 1);
    return inherited;
  }
  const ref = raw.match(/^var\(--([a-z-]+)\)$/);
  if (ref && depth < 4) return resolve(block, ref[1]!, depth + 1);
  return raw;
}

/** oklch(<L> <C> <H>[ / <alpha>]) → [r, g, b] in 0..1 linear-light sRGB. */
function oklchToLinear(lc: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = lc + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = lc - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = lc - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function parseOklch(raw: string): { l: number; c: number; h: number; alpha: number } | null {
  const match = raw.match(/oklch\(\s*([\d.]+)%?\s+([\d.]+)\s+([\d.-]+)(?:\s*\/\s*([\d.%]+))?\s*\)/);
  if (!match) return null;
  let alpha = 1;
  if (match[4] !== undefined) {
    alpha = match[4]!.endsWith("%") ? Number(match[4]!.slice(0, -1)) / 100 : Number(match[4]);
  }
  return { l: Number(match[1]) > 1 ? Number(match[1]) / 100 : Number(match[1]), c: Number(match[2]), h: Number(match[3]), alpha };
}

/** Relative luminance per WCAG (alpha composited over an optional backdrop). */
function luminance(raw: string, backdrop = ""): number {
  const color = parseOklch(raw);
  if (!color) return -1;
  const bg = backdrop ? parseOklch(backdrop) : null;
  const linear = oklchToLinear(color.l, color.c, color.h).map((channel) => Math.min(1, Math.max(0, channel)));
  const composed = bg
    ? (() => {
        const bgLinear = oklchToLinear(bg.l, bg.c, bg.h).map((channel) => Math.min(1, Math.max(0, channel)));
        return linear.map((channel, index) => channel * color.alpha + bgLinear[index]! * (1 - color.alpha));
      })()
    : linear;
  // WCAG relative luminance uses the LINEAR channels directly (the sRGB
  // gamma was already inverted by the oklch→linear conversion above).
  const [r, g, b] = composed;
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(fg: string, bg: string): number {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  if (l1 < 0 || l2 < 0) return -1;
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("v0.9.0 theme token completeness", () => {
  it("ships all 8 built-in themes (dark, light + 6 named)", () => {
    const names = THEMES.map((theme) => theme.name).sort();
    assert.deepEqual(names, ["amber", "dark", "forest", "graphite", "light", "midnight", "ocean", "slate"]);
  });

  for (const { name, block } of THEMES) {
    it(`theme "${name}" defines the full semantic token set`, () => {
      for (const token of [
        "background", "surface", "surface-elevated", "text", "text-secondary",
        "border", "accent-brand", "accent-brand-foreground", "success", "warning",
        "danger", "info", "offline", "chart-1", "chart-2", "chart-3", "chart-4", "chart-5",
        "shadow-card", "space-card-x",
      ]) {
        assert.ok(valueOf(block, token) !== null || css.includes(`--${token}:`), `${name}: missing --${token}`);
      }
    });
  }

  it("accent overrides never redefine status semantics", () => {
    for (const match of css.matchAll(/\[data-accent="([a-z]+)"\] \{([^}]+)\}/g)) {
      assert.ok(!/--success|--warning|--danger|--info|--offline/.test(match[2]!), `accent ${match[1]} must not touch status tokens`);
    }
  });
});

describe("v0.9.0 WCAG contrast (AA, >= 4.5:1 core pairs)", () => {
  const CASES: Array<{ fg: string; bg: string; label: string; min: number }> = [
    { fg: "text", bg: "background", label: "normal text on background", min: 4.5 },
    { fg: "text-secondary", bg: "background", label: "secondary text on background", min: 4.5 },
    { fg: "text", bg: "surface", label: "text on surface", min: 4.5 },
    { fg: "text-secondary", bg: "surface", label: "secondary text on surface", min: 4.5 },
    { fg: "accent-brand-foreground", bg: "accent-brand", label: "accent button text", min: 3 },
    { fg: "success-foreground", bg: "success", label: "success badge", min: 3 },
    { fg: "warning-foreground", bg: "warning", label: "warning badge", min: 3 },
    { fg: "danger-foreground", bg: "danger", label: "danger badge", min: 3 },
    { fg: "info-foreground", bg: "info", label: "info badge", min: 3 },
  ];

  for (const { name, block } of THEMES) {
    for (const { fg, bg, label, min } of CASES) {
      it(`${name}: ${label} >= ${min}`, () => {
        const fgValue = resolve(block, fg);
        const bgValue = resolve(block, bg);
        assert.ok(fgValue && bgValue, `${name}: ${fg}/${bg} undefined`);
        const ratio = contrast(fgValue, bgValue);
        assert.ok(
          ratio >= min,
          `${name}: ${label} contrast ${ratio.toFixed(2)} < ${min} (${fgValue} on ${bgValue})`,
        );
      });
    }
  }
});

describe("v0.9.0 accent safety (contrast on accents)", () => {
  it("every predefined accent passes >= 3 with its foreground (UI labels)", () => {
    for (const match of css.matchAll(/\[data-accent="([a-z]+)"\] \{([^}]+)\}/g)) {
      const accent = match[1]!;
      const brand = match[2]!.match(/--accent-brand: ([^;]+);/)?.[1];
      const fg = match[2]!.match(/--accent-brand-foreground: ([^;]+);/)?.[1];
      if (!brand || !fg || brand.includes("var(")) continue; // custom resolves at runtime
      const ratio = contrast(fg, brand);
      assert.ok(ratio >= 3, `accent ${accent}: contrast ${ratio.toFixed(2)} < 3`);
    }
  });
});
