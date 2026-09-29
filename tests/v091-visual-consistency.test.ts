import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

/** Storage health language (v0.9.1): one mapping, applied everywhere. */
describe("v0.9.1 storage health language", () => {
  const health = read("src/components/storage/health.tsx");
  const storagePage = read("src/app/storage/page.tsx");

  it("maps Unraid disk states/colors to semantic tones", () => {
    assert.match(health, /DISK_DSBL|DISK_INVALID/);
    assert.match(health, /RED_BALL/);
    assert.match(health, /DISK_NP/);
    assert.match(health, /return "critical"/);
    assert.match(health, /return "warning"/);
    assert.match(health, /return "healthy"/);
  });

  it("array verdict considers array state + worst disk", () => {
    assert.match(health, /arrayHealthTone/);
    assert.match(health, /!== "STARTED"/);
    assert.match(health, /tones\.includes\("critical"\)/);
  });

  it("utilization thresholds are semantic (75 warn / 90 critical)", () => {
    assert.match(health, /percent >= 90[\s\S]*?bg-danger/);
    assert.match(health, /percent >= 75[\s\S]*?bg-warning/);
  });

  it("storage page uses the shared mapping — no ad-hoc color balls", () => {
    assert.match(storagePage, /diskHealthTone\(disk\)/);
    assert.match(storagePage, /StatusDot tone=\{row\.tone\}/);
    assert.ok(!/fsColor\]\s*\?\?|COLOR_CLASS/.test(storagePage), "raw color-class tables removed");
    assert.ok(!/bg-emerald|text-emerald|bg-red-\d|text-red-\d/.test(storagePage), "no ad-hoc palette");
  });

  it("mobile cards exist and desktop table is md+-gated (no squeezed tables)", () => {
    assert.match(storagePage, /hidden md:block/);
    assert.match(storagePage, /grid gap-2\.5 md:hidden/);
  });

  it("hero carries capacity bar + warnings + live IO", () => {
    assert.match(storagePage, /CapacityBar/);
    assert.match(storagePage, /Active warnings/);
    assert.match(storagePage, /Disk I\/O \(live\)/);
    assert.match(storagePage, /Usable capacity/);
  });

  it("temperature verdicts: 45 warn / 50 critical", () => {
    assert.match(health, /tempC >= 50[\s\S]*?critical/);
    assert.match(health, /tempC >= 45[\s\S]*?warning/);
  });
});

/** NOC (v0.9.1): purpose-built wallboard with alert mode + context. */
describe("v0.9.1 NOC redesign", () => {
  const noc = read("src/app/noc/page.tsx");

  it("has an alert ring (not blinking) and semantic danger color", () => {
    assert.match(noc, /border-danger\/70 ring-1 ring-danger\/40/);
    assert.match(noc, /StatusDot/);
    assert.ok(!/animate-blink|animate-flash/.test(noc));
  });

  it("shows subtle clock/date context that never competes", () => {
    assert.match(noc, /toLocaleDateString/);
    assert.match(noc, /toLocaleTimeString/);
    assert.match(noc, /text-muted-foreground/);
  });

  it("carries the Beacon identity", () => {
    assert.match(noc, /BeaconMark/);
  });

  it("keeps auto-cycle polish: pause-on-interaction + resume + indicator", () => {
    assert.match(noc, /CYCLE_RESUME_AFTER_IDLE_S/);
    assert.match(noc, /markInteraction/);
    assert.match(noc, /% CYCLE_PANELS\.length/);
  });

  it("remains read-only (no lifecycle controls)", () => {
    assert.match(noc, /read-only by design/);
    assert.ok(!/requestContainerUpdate|requestComposeUpdate|automationTick/.test(noc));
  });
});

/** Component consistency (v0.9.1): card/badge/status usage. */
describe("v0.9.1 component consistency", () => {
  it("Card uses the shadow-card token (theme-adaptive depth)", () => {
    const card = read("src/components/ui/card.tsx");
    assert.match(card, /shadow-card/);
    const globals = read("src/app/globals.css");
    assert.match(globals, /--shadow-card: 0 1px 2px oklch\(0 0 0 \/ 25%\)/);
    assert.match(globals, /--shadow-card: 0 1px 2px oklch\(0\.3 0\.01 260 \/ 8%\)/);
  });

  it("Badge exposes only semantic variants", () => {
    const badge = read("src/components/ui/badge.tsx");
    for (const variant of ["default", "secondary", "outline", "success", "warning", "destructive", "muted"]) {
      assert.match(badge, new RegExp(`${variant}:`), `badge variant ${variant}`);
    }
    assert.ok(!/bg-emerald|bg-sky-\d|bg-amber-\d/.test(badge), "no palette-class variants");
  });

  it("StatusDot is the single status-dot primitive", () => {
    const status = read("src/components/ui/status.tsx");
    assert.match(status, /healthy: "bg-success"/);
    assert.match(status, /critical: "bg-danger"/);
    assert.match(status, /offline: "bg-offline"/);
  });

  it("navigation groups are complete: every item has a valid group", () => {
    const nav = read("src/lib/navigation.ts");
    for (const group of ["overview", "infrastructure", "operations", "observe", "configure"]) {
      assert.match(nav, new RegExp(`group: "${group}"`));
    }
    assert.match(nav, /NAV_GROUP_LABELS/);
  });

  it("charts consume theme tokens (no hard-coded hex series)", () => {
    const chart = read("src/components/dashboard/series-chart.tsx");
    assert.match(chart, /var\(--color-chart-1\)/);
    assert.match(chart, /var\(--color-border\)/);
    assert.match(chart, /var\(--color-muted-foreground\)/);
  });
});

/** Light theme depth model (v0.9.1): surfaces differ from background. */
describe("v0.9.1 light theme depth model", () => {
  const globals = read("src/app/globals.css");
  const lightBlock = globals.match(/\[data-theme="light"\] \{([\s\S]*?)\n\}/)?.[1] ?? "";

  it("light surfaces differ from the background (elevation exists)", () => {
    assert.match(lightBlock, /--background: oklch\(0\.975/);
    assert.match(lightBlock, /--surface: oklch\(1 0 0\)/);
    assert.match(lightBlock, /--shadow-card: 0 1px 2px oklch\(0\.3 0\.01 260 \/ 8%\)/);
  });

  it("dark themes define their own shadow token (not shared with light)", () => {
    assert.match(globals, /--shadow-card: 0 1px 2px oklch\(0 0 0 \/ 25%\)/);
  });

  it("compact density trims card padding via token override", () => {
    assert.match(globals, /\[data-density="compact"\] \[data-slot="card"\]/);
    assert.match(globals, /--space-card-x: 0\.875rem/);
  });

  it("reduced motion collapses animation (preference AND OS setting)", () => {
    assert.match(globals, /\[data-motion="reduced"\] \*/);
    assert.match(globals, /@media \(prefers-reduced-motion: reduce\)/);
  });
});
