import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

describe("v0.9.5 mobile UX + docker operations", () => {
  const header = read("src/components/layout/header.tsx");
  const bottomNav = read("src/components/layout/bottom-nav.tsx");
  const sidebar = read("src/components/layout/sidebar.tsx");
  const dockerPage = read("src/app/docker/page.tsx");

  it("header shows the Views control only on the overview page", () => {
    assert.match(header, /const showViews = pathname === "\/";/);
    assert.match(header, /\{showViews && <ViewsMenu \/>\}/);
  });

  it("header keeps health visible at every width and collapses the data-status badge on phones", () => {
    // Data-status badge wrapped in a hidden-below-sm span (health stays).
    assert.match(header, /hidden sm:inline-flex">\{dataStatusBadge\(overview\)\}/);
    // The health badge itself carries no responsive hiding.
    assert.doesNotMatch(header, /hidden sm:inline-flex">\{healthBadge/);
  });

  it("More sheet caps at 100dvh, scrolls internally, and locks body scroll while open", () => {
    assert.match(bottomNav, /max-h-\[100dvh\] overflow-y-auto overscroll-contain/);
    assert.match(bottomNav, /document\.body\.style\.overflow = "hidden"/);
  });

  it("mobile drawer locks body scroll and exposes dialog semantics while open", () => {
    assert.match(sidebar, /if \(!mobileOpen\) return;\s*const previous = document\.body\.style\.overflow;/);
    assert.match(sidebar, /role=\{mobileOpen \? "dialog" : undefined\}/);
    assert.match(sidebar, /aria-label=\{mobileOpen \? "Navigation" : undefined\}/);
  });

  it("docker page renders the container section before the secondary panels", () => {
    const containersAt = dockerPage.indexOf('id="docker-containers"');
    const updatesAt = dockerPage.indexOf('id="docker-updates"');
    const projectsAt = dockerPage.indexOf('id="docker-projects"');
    const historyAt = dockerPage.indexOf('id="docker-history"');
    assert.ok(containersAt > -1 && updatesAt > -1 && projectsAt > -1 && historyAt > -1);
    assert.ok(containersAt < updatesAt, "containers must precede updates");
    assert.ok(updatesAt < projectsAt, "updates must precede projects");
    assert.ok(projectsAt < historyAt, "projects must precede history");
  });

  it("docker secondary sections are lazy: their polls never start on page load", () => {
    assert.match(dockerPage, /<LazySection label="Updates"[^>]*>\s*<DockerUpdatesPanel \/>\s*<\/LazySection>/);
    assert.match(dockerPage, /<LazySection label="Projects"[^>]*>\s*<ComposeProjectsPanel \/>\s*<\/LazySection>/);
    assert.match(dockerPage, /<LazySection label="History"[^>]*>\s*<UpdateHistoryPanel \/>\s*<\/LazySection>/);
    assert.match(dockerPage, /const \[open, setOpen\] = useState\(false\);/);
  });

  it("docker defaults to the operational sort (unhealthy → running → stopped → unknown)", () => {
    assert.match(dockerPage, /useState<SortKey>\("operational"\)/);
    assert.match(dockerPage, /if \(c\.health === "unhealthy"\) return 0;/);
    assert.match(dockerPage, /if \(c\.state === "RUNNING"\) return 1;/);
  });

  it("docker quick actions are start/stop only — restart is never offered", () => {
    // The Unraid API exposes no verified docker restart; only start/stop ship.
    assert.match(dockerPage, /canQuickAction/);
    assert.doesNotMatch(dockerPage, /"restart"/);
  });

  it("docker quick actions run confirm-then-post through the guarded action runner with toast feedback", () => {
    assert.match(dockerPage, /<ConfirmDialog/);
    assert.match(dockerPage, /runContainerAction\(\{\s*kind: "docker",\s*action: request\.action,\s*id: request\.id,\s*\}\)/);
    assert.match(dockerPage, /toast\("success"/);
    assert.match(dockerPage, /toast\("error"/);
    assert.match(dockerPage, /disabled=\{actionPending\?\.id === container\.id\}/);
  });

  it("overlay z-index ladder stays ordered (header < drawer < sheet < palette < toast < auth)", () => {
    assert.match(header, /sticky top-0 z-30/);
    assert.match(sidebar, /z-40 bg-black\/60/); // drawer scrim
    assert.match(sidebar, /inset-y-0 left-0 z-50/); // drawer
    assert.match(bottomNav, /z-\[60\] bg-black\/60/); // sheet scrim
    assert.match(bottomNav, /z-\[61\]/); // sheet
    assert.match(bottomNav, /z-\[62\]/); // bottom nav above its sheet
    const palette = read("src/components/layout/command-palette.tsx");
    const toasts = read("src/components/layout/toast.tsx");
    const authOverlay = read("src/components/layout/auth-expired-overlay.tsx");
    assert.match(palette, /z-\[80\]/);
    assert.match(toasts, /z-\[90\]/);
    assert.match(authOverlay, /z-\[100\]/);
  });

  it("main content clears the fixed bottom nav via the authoritative clearance token", () => {
    const shell = read("src/components/layout/app-shell.tsx");
    // v0.9.7: clearance moved into --mobile-bottom-clearance (globals.css).
    assert.match(shell, /pb-\[var\(--mobile-bottom-clearance\)\] sm:p-6 md:pb-6/);
    const css = read("src/app/globals.css");
    assert.match(css, /--mobile-bottom-clearance: calc\(env\(safe-area-inset-bottom, 0px\) \+ 4\.75rem\)/);
  });
});
