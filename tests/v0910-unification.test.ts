import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

describe("v0.9.10 shared action controller + capability model + thermal context", () => {
  const controller = read("src/components/actions/use-docker-action.ts");
  const listPage = read("src/app/docker/page.tsx");
  const detailPage = read("src/app/docker/[name]/page.tsx");
  const caps = read("src/lib/action-capabilities.ts");

  it("normalized capability model: enabled → start/stop true, restart/pause/unpause always false", async () => {
    const { normalizeActionCapabilities } = await import("../src/lib/action-capabilities");
    const enabled = normalizeActionCapabilities({ enabled: true, reason: null, docker: ["start", "stop"] });
    assert.deepEqual(enabled.docker, { enabled: true, start: true, stop: true, restart: false, pause: false, unpause: false });
    const disabled = normalizeActionCapabilities({ enabled: false, reason: "no key", docker: [] });
    assert.deepEqual(disabled.docker, { enabled: false, start: false, stop: false, restart: false, pause: false, unpause: false });
    assert.equal(disabled.reason, "no key");
    // Even a hostile/incorrect capability list can never produce restart/pause.
    const hostile = normalizeActionCapabilities({ enabled: true, reason: null, docker: ["restart", "pause"] });
    assert.equal(hostile.docker.restart, false);
    assert.equal(hostile.docker.pause, false);
  });

  it("missing key → disabled with reason; actions route carries the normalized model", () => {
    const route = read("src/app/api/actions/status/route.ts");
    assert.match(route, /capabilities: \{/);
    assert.match(route, /restart: false/);
    assert.match(route, /UNRAID_ACTION_API_KEY missing/);
  });

  it("invalid key is rejected server-side by exact comparison, never echoed", () => {
    const client = read("src/server/actions/action-client.ts");
    assert.match(client, /UNRAID_ACTION_API_KEY/);
    assert.doesNotMatch(client, /return.*UNRAID_ACTION_API_KEY|JSON\.stringify\(\{[^}]*key/);
  });

  it("ONE shared controller — list and detail both consume it, neither defines its own", () => {
    assert.match(listPage, /useDockerAction\(\)/);
    assert.match(detailPage, /useDockerAction\(\)/);
    assert.doesNotMatch(listPage, /useActionRunner/);
    assert.doesNotMatch(detailPage, /useActionRunner/);
    // The controller holds the whole machine.
    assert.match(controller, /state-transition/);
    assert.match(controller, /setInterval/); // bounded poll fallback
    assert.match(controller, /STOP_TIMEOUT_MS = 45_000/);
    assert.match(controller, /START_TIMEOUT_MS = 90_000/);
    assert.match(controller, /via: "sse" \| "poll"/);
  });

  it("detail page binds the shared confirm dialog and shows the completion path", () => {
    assert.match(detailPage, /onConfirm=\{\(\) => dockerAction\.confirm\(\)\}/);
    assert.match(detailPage, /confirmed via \$\{dockerAction\.result\.via === "sse" \? "live event" : "state poll"\}/);
  });

  it("automation surfaces the lifecycle-capability blocker without faking actionability", () => {
    const automation = read("src/app/automation/page.tsx");
    assert.match(automation, /Action capability unavailable/);
    assert.match(automation, /Update automation is helper-driven and unaffected/);
  });

  it("Agent API exposes capability context but remains read-only", () => {
    const snapshot = read("src/server/agent/snapshot.ts");
    assert.match(snapshot, /actionCapabilities/);
    assert.match(snapshot, /restart: false as const/);
    const agentDir = path.join(repoRoot, "src/app/api/agent/v1");
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name === "route.ts") out.push(full);
      }
      return out;
    };
    for (const file of walk(agentDir)) {
      const source = read(path.relative(repoRoot, file));
      assert.doesNotMatch(source, /export async function POST|export async function DELETE|export async function PUT/);
    }
  });

  it("thermal 7-day aggregation: sustained episodes need 15 min; slope needs 5 days", async () => {
    const { countSustainedEpisodes, dailySlope } = await import("../src/server/prometheus/thermal");
    // 3 consecutive 5-min samples at/above threshold = 1 episode.
    const values = [70, 81, 82, 83, 70, 75, 91, 92, 93, 70, 70, 81, 70];
    assert.equal(countSustainedEpisodes(values, 80), 2);
    assert.equal(countSustainedEpisodes(values, 90), 1);
    assert.equal(countSustainedEpisodes([81, 70, 82, 70, 83, 70], 80), 0, "isolated spikes are not episodes");
    // Slope: flat series → 0; fewer than 5 days → null (no trend claimed).
    assert.equal(dailySlope([70, 70, 70, 70, 70, 70, 70]), 0);
    assert.equal(dailySlope([70, null, 71, null, 72, null]), null);
    const rising = dailySlope([70, 71, 72, 73, 74, 75, 76]);
    assert.equal(rising, 1);
  });

  it("thermal analysis endpoint and card expose the 7-day context", () => {
    const route = read("src/app/api/thermal/analysis/route.ts");
    assert.match(route, /getThermal7dContext/);
    const card = read("src/components/dashboard/thermal-analysis-card.tsx");
    assert.match(card, /7-day context/);
    assert.match(card, /no trend is claimed/);
  });

  it("health popover links thermal reasons to the System thermal section", () => {
    const header = read("src/components/layout/header.tsx");
    assert.match(header, /View thermal history/);
    assert.match(header, /\/system#thermal/);
    const system = read("src/app/system/page.tsx");
    assert.match(system, /id="thermal"/);
  });

  it("update-awareness regression: summary endpoint stays cache-only", () => {
    const summaryRoute = read("src/app/api/docker/updates-summary/route.ts");
    assert.match(summaryRoute, /updatesSummaryFromCache/);
    assert.doesNotMatch(summaryRoute, /updatesOverview|ensureChecks|fetchInventory/);
  });
});
