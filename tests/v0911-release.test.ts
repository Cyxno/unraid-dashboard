import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Automation positive-path env must be set BEFORE any server env module
// evaluates (getEnv caches per process). Test files run in their own
// process under node --test.
process.env.ENABLE_ACTIONS = "true";
process.env.UNRAID_ACTION_API_KEY = "a".repeat(32);
// Required by server env validation (test dummies, never real credentials).
process.env.UNRAID_URL = "http://127.0.0.1:1";
process.env.UNRAID_API_KEY = "b".repeat(32);

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

describe("v0.9.11 thermal intelligence + capability-aware automation + PWA", () => {
  describe("thermal classification", () => {
    it("idle-hot: elevated temp + low CPU + no correlation + low power", async () => {
      const { classifyEpisode } = await import("../src/server/prometheus/thermal-diagnostics");
      const verdict = classifyEpisode({
        avgCpuPercent: 15,
        tempVsCpu: 0.1,
        tempVsPower: 0.1,
        avgPowerWatts: 20,
        powerBaselineWatts: 22,
      });
      assert.equal(verdict, "idle-hot");
    });

    it("idle-hot applies when power is unknown but correlations are flat and CPU is low", async () => {
      const { classifyEpisode } = await import("../src/server/prometheus/thermal-diagnostics");
      assert.equal(
        classifyEpisode({ avgCpuPercent: 20, tempVsCpu: 0.1, tempVsPower: null, avgPowerWatts: null }),
        "idle-hot",
      );
    });

    it("idle-hot never fires when CPU is high or load-correlation is strong", async () => {
      const { classifyEpisode } = await import("../src/server/prometheus/thermal-diagnostics");
      assert.equal(
        classifyEpisode({ avgCpuPercent: 80, tempVsCpu: 0.1, tempVsPower: 0.1, avgPowerWatts: 20, powerBaselineWatts: 22 }),
        "load-correlated",
      );
      assert.equal(
        classifyEpisode({ avgCpuPercent: 15, tempVsCpu: 0.8, tempVsPower: 0.1, avgPowerWatts: 20, powerBaselineWatts: 22 }),
        "load-correlated",
      );
    });

    it("idle-hot does not fire when power is clearly above baseline", async () => {
      const { classifyEpisode } = await import("../src/server/prometheus/thermal-diagnostics");
      assert.equal(
        classifyEpisode({ avgCpuPercent: 15, tempVsCpu: 0.1, tempVsPower: 0.1, avgPowerWatts: 40, powerBaselineWatts: 22 }),
        "unexplained",
      );
    });

    it("sustained-run detection: >=3 samples are an episode, isolated spikes are not", async () => {
      const { detectSustainedRuns } = await import("../src/server/prometheus/thermal");
      const runs = detectSustainedRuns([70, 81, 82, 83, 70, 75, 91, 92, 93, 70, 70, 81, 70], 300, 80, 3);
      assert.equal(runs.length, 2);
      assert.deepEqual(
        runs.map((run) => run.samples),
        [3, 3],
      );
      assert.equal(runs[0]!.ongoing, false);
      assert.equal(detectSustainedRuns([81, 70, 82, 70, 83, 70], 300, 80, 3).length, 0);
      const ongoing = detectSustainedRuns([70, 70, 85, 86, 87], 300, 80, 3);
      assert.equal(ongoing.length, 1);
      assert.equal(ongoing[0]!.ongoing, true);
    });
  });

  describe("automation capability context", () => {
    it("lifecycle workflows become eligible when the action capability is enabled; helper offline blocks updates", async () => {
      const { automationCapabilityContext } = await import("../src/server/automation/capabilities");
      const context = await automationCapabilityContext();
      const byName = new Map(context.workflows.map((workflow) => [workflow.workflow, workflow]));

      const start = byName.get("lifecycle-start")!;
      assert.equal(start.eligible, true, "env sets ENABLE_ACTIONS + key → start available");
      assert.deepEqual(start.requiredCapabilities, ["docker:start"]);
      assert.deepEqual(start.blockers, []);

      const stop = byName.get("lifecycle-stop")!;
      assert.equal(stop.eligible, true);

      // Test process has no update helper configured → update workflow blocked.
      const update = byName.get("update-helper")!;
      assert.equal(update.eligible, false);
      assert.deepEqual(update.blockers, ["Update helper offline"]);

      // Restart is permanently blocked by the verified API surface.
      const restart = byName.get("restart")!;
      assert.equal(restart.eligible, false);
      assert.deepEqual(restart.blockers, ["Restart unsupported by verified Unraid API"]);
    });

    it("the capability context shape matches the normalized model (single source)", async () => {
      const { automationCapabilityContext } = await import("../src/server/automation/capabilities");
      const context = await automationCapabilityContext();
      for (const workflow of context.workflows) {
        assert.equal(
          workflow.eligible,
          workflow.blockers.length === 0,
          "eligible must be exactly blockers.length === 0",
        );
        assert.ok(Array.isArray(workflow.requiredCapabilities));
        assert.ok(Array.isArray(workflow.availableCapabilities));
      }
    });

    it("pipeline-owned containers stay blocked regardless of capabilities", async () => {
      const { computeAutoEligibility } = await import("../src/server/update/eligibility");
      const verdict = computeAutoEligibility({
        container: {
          name: "tornscope-web-1",
          risk: "LOW",
          health: "healthy",
          management_type: "pipeline_owned",
          externallyManaged: false,
          update_available: true,
          rollback: { snapshot_present: true },
        } as never,
        manualSuccesses: 9,
        rollbackCount: 0,
        pilotAllowlist: ["tornscope-web-1"],
      });
      assert.equal(verdict.eligible, false);
      assert.ok(verdict.reasons.some((reason) => reason.includes("externally managed")));
    });
  });

  describe("PWA invariants", () => {
    it("safe-area system invariants hold (clearance token + safe-top + cover)", () => {
      const css = read("src/app/globals.css");
      assert.match(css, /--mobile-bottom-clearance: calc\(env\(safe-area-inset-bottom, 0px\) \+ 4\.75rem\)/);
      // v1.1.2 regression fix: the header GROWS by the top inset instead of
      // padding a fixed h-14 (content was squeezed/clipped under the
      // black-translucent status bar on notched iPhones in standalone).
      assert.match(css, /--safe-area-top: env\(safe-area-inset-top, 0px\)/);
      assert.match(css, /--shell-header-height: calc\(3\.5rem \+ var\(--safe-area-top\)\)/);
      assert.match(css, /\.safe-top \{\s*padding-top: var\(--safe-area-top\);/);
      const header = read("src/components/layout/header.tsx");
      assert.match(header, /h-\[var\(--shell-header-height\)\]/, "header height must include the safe-area inset");
      const sidebar = read("src/components/layout/sidebar.tsx");
      assert.match(sidebar, /h-\[var\(--shell-header-height\)\]/, "sidebar identity row must stay aligned with the header");
      const banner = read("src/components/layout/pwa-status-banner.tsx");
      assert.match(banner, /top-\[var\(--shell-header-height\)\]/, "sticky banners must offset below the grown header");
      const layout = read("src/app/layout.tsx");
      assert.match(layout, /viewportFit: "cover"/);
      assert.match(layout, /appleWebApp: \{[\s\S]*?capable: true/);
    });

    it("service worker version tracks the deployed version source", () => {
      const sw = read("public/sw.js");
      // The sync script prefers APP_VERSION (CI/tag builds) over package.json
      // — promotion of an RC commit must still stamp the deployed version.
      const sync = read("scripts/sync-sw-version.mjs");
      assert.match(sync, /APP_VERSION/);
      const pkg = JSON.parse(read("package.json"));
      assert.match(sw, new RegExp(`VERSION = "v${pkg.version}"`));
    });

    it("manifest stays current and icon URLs stay cache-busted", () => {
      const manifest = JSON.parse(read("public/manifest.webmanifest"));
      assert.equal(manifest.short_name, "Beacon");
      assert.equal(manifest.display, "standalone");
      for (const icon of manifest.icons) assert.match(icon.src, /\?v=/);
      const pwaDoc = read("docs/PWA.md");
      assert.match(pwaDoc, /real-device checklist/i);
    });

    it("thermal wording stays associative — never causal", () => {
      const card = read("src/components/dashboard/thermal-diagnostics-card.tsx");
      assert.match(card, /never causal|associative/i);
      const analysisCard = read("src/components/dashboard/thermal-analysis-card.tsx");
      assert.match(analysisCard, /no trend is claimed/);
    });
  });
});
