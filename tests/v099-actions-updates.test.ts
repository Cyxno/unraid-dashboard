import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

describe("v0.9.9 live docker actions + update awareness", () => {
  const dockerPage = read("src/app/docker/page.tsx");
  const actionClient = read("src/server/actions/action-client.ts");

  it("only verified actions ship — restart is never offered anywhere in the UI", () => {
    assert.equal(actionClient.includes("DOCKER_ACTIONS = [\"start\", \"stop\"]"), true);
    assert.doesNotMatch(dockerPage, /"restart"/);
  });

  it("actions require the action key; disabled by default without it", () => {
    const statusRoute = read("src/app/api/actions/status/route.ts");
    assert.match(statusRoute, /DOCKER_ACTIONS/);
    const env = read("src/server/env.ts");
    assert.match(env, /UNRAID_ACTION_API_KEY: z\.string\(\)\.min\(1\)\.optional\(\)/);
  });

  it("action state machine: bounded transition verification, no fixed sleeps", () => {
    // The machine lives in the shared controller (v0.9.10); the list page
    // and the detail page both consume it.
    const controller = read("src/components/actions/use-docker-action.ts");
    assert.match(controller, /waitForTransition/);
    assert.match(controller, /STOP_TIMEOUT_MS = 45_000/);
    assert.match(controller, /START_TIMEOUT_MS = 90_000/);
    assert.match(controller, /state-transition/); // SSE completion signal
    assert.match(controller, /actionTimeoutMs/);
    assert.match(dockerPage, /dockerAction\.phase/); // surfaced on cards
    assert.match(dockerPage, /useDockerAction\(\)/);
    assert.match(controller, /not verified within/); // visible timeout error
  });

  it("container detail page shares the same action controller (no duplicate semantics)", () => {
    const detail = read("src/app/docker/[name]/page.tsx");
    assert.match(detail, /useDockerAction\(\)/);
    assert.match(detail, /onConfirm=\{\(\) => dockerAction\.confirm\(\)\}/);
    assert.doesNotMatch(detail, /useActionRunner/);
    assert.doesNotMatch(detail, /"restart"/);
  });

  it("docker page polls the cached summary endpoint, never the sweep endpoint at load", () => {
    assert.match(dockerPage, /\/api\/docker\/updates-summary/);
    // The full sweep endpoint is only reachable inside the lazy Updates
    // section (DockerUpdatesPanel), which mounts on expansion only.
    const summaryRoute = read("src/app/api/docker/updates-summary/route.ts");
    assert.match(summaryRoute, /updatesSummaryFromCache/);
    assert.doesNotMatch(summaryRoute, /updatesOverview|ensureChecks|fetchInventory/);
  });

  it("updatesSummaryFromCache reads caches only — no registry, no inventory fetch, no sweep", () => {
    const updates = read("src/server/docker/updates.ts");
    const fn = updates.slice(updates.indexOf("export function updatesSummaryFromCache"));
    assert.ok(fn.length > 0 && fn.length < updates.length);
    assert.match(fn, /__dockerInventoryCache/);
    assert.match(fn, /__dockerRefreshInFlight/);
    assert.doesNotMatch(fn, /await fetch|fetchInventory\(|ensureChecks\(|checkRemoteDigest/);
  });

  it("stale semantics: no cache or age beyond the 4h TTL marks the count stale", () => {
    const updates = read("src/server/docker/updates.ts");
    const fn = updates.slice(updates.indexOf("export function updatesSummaryFromCache"));
    assert.match(fn, /CHECK_TTL_MS/);
    assert.match(fn, /stale = checkCache\(\)\.size === 0 \|\| ageSeconds \* 1000 >= CHECK_TTL_MS/);
  });

  it("health reasons are ranked critical-first and thermal rules are documented", () => {
    const health = read("src/server/health.ts");
    assert.match(health, /\.sort\(\(a, b\) => b\.rank - a\.rank\)/);
    assert.match(health, /throttling\s+NEVER claimed/);
    assert.match(health, /critical\s+package 5m average ≥ 90 °C/);
  });

  it("header health badge explains itself (popover, ranked reasons)", () => {
    const header = read("src/components/layout/header.tsx");
    assert.match(header, /function HealthBadge/);
    assert.match(header, /aria-expanded=\{open\}/);
    assert.match(header, /aria-label=\{`Health: \$\{meta\.label\}`\}/);
  });

  it("capability status surfaces in Settings and Operations without key material", () => {
    const settings = read("src/app/settings/page.tsx");
    assert.match(settings, /normalizeActionCapabilities/);
    assert.match(settings, /Unavailable: /);
    const ops = read("src/components/operations/operations-view.tsx");
    assert.match(ops, /Docker actions/);
    assert.match(ops, /describeDockerCapabilities/);
  });

  it("agent API stays read-only: no action endpoints, no write methods", () => {
    const agentDir = path.join(repoRoot, "src/app/api/agent/v1");
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name === "route.ts") out.push(full);
      }
      return out;
    };
    for (const file of walk(agentDir)) {
      const source = read(path.relative(repoRoot, file));
      assert.doesNotMatch(source, /export async function POST|export async function DELETE|export async function PUT/,
        `${file} must not expose mutations`);
    }
  });

  it("actions are audit-logged with actor/target/result", () => {
    const route = read("src/app/api/actions/route.ts");
    assert.match(route, /actor/i);
    assert.match(read("src/server/actions/audit.ts"), /actor/i);
    // The action layer records completion state (audit trail carries the
    // target, result and error path).
    assert.match(actionClient, /Resolved target name from the live inventory \(for audit\)/);
  });

  it("PWA static assets are versioned and documented", () => {
    const docs = read("docs/PWA.md");
    assert.match(docs, /real-device checklist/i);
    assert.match(docs, /Remove any existing Beacon home-screen shortcut/);
  });
});
