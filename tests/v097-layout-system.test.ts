import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

describe("v0.9.7 layout system + spacing correctness + PWA identity", () => {
  const css = read("src/app/globals.css");
  const primitives = read("src/components/dashboard/layout-primitives.tsx");

  it("spacing tokens are centralized in the theme", () => {
    assert.match(css, /--spacing-page: 1\.25rem;/);
    assert.match(css, /--spacing-section: 1rem;/);
    assert.match(css, /--spacing-card: 0\.75rem;/);
  });

  it("one authoritative mobile bottom-clearance variable exists", () => {
    assert.match(css, /--mobile-bottom-clearance: calc\(env\(safe-area-inset-bottom, 0px\) \+ 4\.75rem\)/);
    // Everything that scrolls carries the token — main AND the footer
    // after it (the footer without clearance hid under the nav once).
    const appShell = read("src/components/layout/app-shell.tsx");
    const pbVar = /pb-\[var\(--mobile-bottom-clearance\)\]/;
    assert.match(appShell, pbVar);
    assert.match(appShell, /footer[^>]*className="[^"]*pb-\[var\(--mobile-bottom-clearance\)\]/);
    assert.doesNotMatch(appShell, /env\(safe-area-inset-bottom\)\+4\.75rem/);
  });

  it("layout primitives exist and encode the no-stretch column policy", () => {
    assert.match(primitives, /export function PageStack/);
    assert.match(primitives, /export function SectionStack/);
    assert.match(primitives, /export function AdaptiveColumns/);
    assert.match(primitives, /export function MetricGrid/);
    assert.match(primitives, /grid items-start gap-card md:grid-cols-2/);
  });

  it("overview uses PageStack and independent column stacks (v0.9.12 flow model)", () => {
    const overview = read("src/app/page.tsx");
    assert.match(overview, /<PageStack>/);
    assert.match(overview, /aria-label="Server detail"[\s\S]*?grid items-start gap-card xl:grid-cols-2/);
    assert.match(overview, /<SectionStack className="min-w-0">/);
  });

  it("settings uses independent stacks with balanced content", () => {
    const settings = read("src/app/settings/page.tsx");
    assert.match(settings, /<PageStack>/);
    assert.match(settings, /<AdaptiveColumns/);
    // The dense content is split across both stacks now: Security model
    // moved left of the columns boundary, Agent API card rendered at all.
    const leftIdx = settings.indexOf("left={");
    const securityModelIdx = settings.indexOf("Security model");
    const rightIdx = settings.indexOf("right={");
    assert.ok(leftIdx > -1 && rightIdx > -1 && leftIdx < securityModelIdx && securityModelIdx < rightIdx);
    assert.match(settings, /<AgentApiSection \/>/);
    // No dead col-span headers inside a column div.
    assert.doesNotMatch(settings, /lg:col-span-2/);
  });

  it("bottom nav is visually intentional (opaque, bordered, shadowed)", () => {
    const nav = read("src/components/layout/bottom-nav.tsx");
    assert.match(nav, /border-t bg-background pb-\[env\(safe-area-inset-bottom\)\] shadow-\[0_-4px_16px_rgb\(0_0_0\/0\.2\)\]/);
    assert.doesNotMatch(nav, /bg-background\/95 backdrop-blur md:hidden/);
  });

  it("update card leads with primary state; provenance/helper detail is collapsed", () => {
    const updates = read("src/components/settings/updates-section.tsx");
    assert.match(updates, /<details className="group rounded-lg border px-3 py-2">/);
    assert.match(updates, /Advanced/);
    // History compacted to 3 with an expander.
    assert.match(updates, /function UpdateHistoryMini/);
    assert.match(updates, /entries\.slice\(0, 3\)/);
    assert.match(updates, /View full history/);
  });

  it("PWA icons are cache-busted, opaque-pipeline, and root-fallbacked", () => {
    const layout = read("src/app/layout.tsx");
    assert.match(layout, /appleWebApp: \{[\s\S]*?capable: true[\s\S]*?statusBarStyle: "black-translucent"/);
    assert.match(layout, /\/icons\/apple-touch-icon\.png\?v=2/);
    assert.match(layout, /\/apple-touch-icon\.png\?v=2/);
    const manifest = JSON.parse(read("public/manifest.webmanifest"));
    assert.equal(manifest.name.startsWith("Beacon"), true);
    assert.equal(manifest.display, "standalone");
    for (const icon of manifest.icons) assert.match(icon.src, /\?v=2$/);
    const generator = read("scripts/generate-icons.mjs");
    assert.match(generator, /"apple-touch-icon\.png", size: 180/);
  });
});
