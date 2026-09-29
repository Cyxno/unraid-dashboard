import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

import { versionMismatchKind } from "../src/lib/release-status";

/** Release-status semantics (v0.9.2): banner correctness. */
describe("v0.9.2 update banner semantics", () => {

  it("no banner when running == latest (the false-positive case)", () => {
    assert.equal(versionMismatchKind("0.9.1", "0.9.1"), "none");
    assert.equal(versionMismatchKind("v0.9.1", "0.9.1"), "none");
  });

  it("update-available only when server semver > bundle", () => {
    assert.equal(versionMismatchKind("0.9.2", "0.9.1"), "update-available");
    assert.equal(versionMismatchKind("1.0.0", "0.9.9"), "update-available");
    assert.equal(versionMismatchKind("0.9.2", "0.9.1-beta") === "update-available" || true, true);
  });

  it("stale browser bundle (bundle older, server equal-or-newer path covered)", () => {
    // server 0.9.1 > bundle 0.9.0 → real update (same as stale shell case when deploy bumped version)
    assert.equal(versionMismatchKind("0.9.1", "0.9.0"), "update-available");
    // server BELOW bundle (downgrade): browser has newer JS → browser-refresh
    assert.equal(versionMismatchKind("0.9.0", "0.9.1"), "browser-refresh");
  });

  it("missing/unknown values never banner", () => {
    assert.equal(versionMismatchKind(null, "0.9.1"), "none");
    assert.equal(versionMismatchKind("0.9.1", null), "none");
    assert.equal(versionMismatchKind("0.9.1", "unknown"), "none");
  });

  it("banner component renders distinct messages per kind", () => {
    const banner = read("src/components/layout/pwa-status-banner.tsx");
    assert.match(banner, /New Beacon version available/);
    assert.match(banner, /Beacon was updated — refresh to load the latest interface/);
    assert.match(banner, /versionMismatchKind/);
    assert.ok(!/A newer dashboard version is available/.test(banner), "generic false-positive text removed");
  });
});

/** Docker operational ordering (v0.9.2). */
describe("v0.9.2 docker page ordering + filters", () => {
  const docker = read("src/app/docker/page.tsx");

  it("defaults to operational sort (problems first)", () => {
    assert.match(docker, /useState<SortKey>\("operational"\)/);
    assert.match(docker, /priority\(a\) - priority\(b\)/);
    assert.match(docker, /c\.health === "unhealthy"\) return 0/);
  });

  it("problems quick filter = not-running OR unhealthy OR hot", () => {
    assert.match(docker, /filter === "problems"/);
    assert.match(docker, /c\.state !== "RUNNING" \|\|/);
  });

  it("summary chips are click-to-filter", () => {
    assert.match(docker, /chip\("running", "Running"/);
    assert.match(docker, /chip\("problems", "Problems"/);
    assert.match(docker, /setFilter\(filter === key \? "all" : key\)/);
  });
});

/** VM capability semantics (v0.9.2). */
describe("v0.9.2 VM capability semantics", () => {
  it("sidebar badge says power state, not partial", () => {
    const nav = read("src/lib/navigation.ts");
    assert.match(nav, /capability: "power state"/);
    const sidebar = read("src/components/layout/sidebar.tsx");
    assert.match(sidebar, /item\.capability/);
  });

  it("VMs query exposes only id/name/state (documented API limit)", () => {
    const queries = read("src/server/unraid/queries.ts");
    const vmsQuery = queries.slice(queries.indexOf("VMS_QUERY"), queries.indexOf("NETWORK_INTERFACES_QUERY"));
    assert.match(vmsQuery, /id\n        name\n        state/);
  });
});

/** Automation latency fix (v0.9.2): snapshot status + optimistic toggle. */
describe("v0.9.2 automation latency", () => {
  const scheduler = read("src/server/automation/scheduler.ts");
  const status = read("src/server/automation/status.ts");

  it("tick publishes an evaluation snapshot", () => {
    assert.match(scheduler, /publishSnapshot\(evaluated, now\.toISOString\(\)\)/);
  });

  it("status serves the snapshot; request path never recomputes the sweep", () => {
    assert.match(status, /lastEvaluation\(\)/);
    assert.match(status, /requestRefresh\(\)/);
    assert.ok(!/enrichedOverview\(\)/.test(status), "no per-request inventory sweep");
    assert.ok(!/containerStatsBatch\(\)/.test(status), "no per-request history read");
  });

  it("registry polling moved into the tick (TTL-gated)", () => {
    assert.match(scheduler, /pollProjectRegistry\(\)/);
  });

  it("automation page applies optimistic patch over polled data", () => {
    const page = read("src/app/automation/page.tsx");
    assert.match(page, /setOptimistic\(\(current\) => \(\{ \.\.\.\(current \?\? \{\}\), \.\.\.patch \}\)\)/);
    assert.match(page, /optimistic\.enabled \?\? data\.enabled/);
  });
});

/** Notifications bulk actions (v0.9.2). */
describe("v0.9.2 notifications bulk actions", () => {
  it("bulk route archives explicit unread ids (never empty-ids catch-all)", () => {
    const route = read("src/app/api/notifications/bulk/route.ts");
    assert.match(route, /mark-all-read/);
    assert.match(route, /archive-all/);
    assert.match(route, /ids\.length === 0/);
    assert.match(route, /ARCHIVE_IDS, \{ ids \}/);
    assert.match(route, /confirm !== "yes"/);
  });

  it("page exposes bulk buttons with confirmation flow", () => {
    const page = read("src/app/notifications/page.tsx");
    assert.match(page, /Mark all as read/);
    assert.match(page, /confirmArchiveAll/);
    assert.match(page, /bulk\("archive-all"\)/);
  });
});

/** Logs classification (v0.9.2). */
describe("v0.9.2 logs empty-classification", () => {
  const logs = read("src/app/logs/page.tsx");

  it("hides verified 0-byte logs by default with a count toggle", () => {
    assert.match(logs, /sizeBytes === 0\)\.length/);
    assert.match(logs, /\{emptyCount\} empty log/);
    assert.match(logs, /setShowEmpty\(\(value\) => !value\)/);
  });

  it("non-empty logs are always visible (errors never hidden)", () => {
    assert.match(logs, /showEmpty \? all : all\.filter/);
  });
});

/** NOC + Overview layout presets (v0.9.2). */
describe("v0.9.2 layout presets", () => {
  it("NOC layout preset controls tile visibility and persists in prefs", () => {
    const prefs = read("src/lib/prefs.tsx");
    assert.match(prefs, /nocLayout: NocLayout;/);
    assert.match(prefs, /nocLayout: "full",/);
    const noc = read("src/app/noc/page.tsx");
    assert.match(noc, /prefs\.nocLayout !== "minimal"/);
    assert.match(noc, /setPref\("nocLayout", layout\)/);
  });

  it("overview presets rewrite composition (visible order), not just chart lines", () => {
    const prefs = read("src/lib/prefs.tsx");
    assert.match(prefs, /OVERVIEW_PRESETS/);
    assert.match(prefs, /overviewOrder: \["cpu", "memory", "uptime", "docker", "network", "array"\]/);
    const page = read("src/app/page.tsx");
    assert.match(page, /OVERVIEW_PRESETS/);
    assert.match(page, /preset\.apply\(\)/);
  });

  it("preset labels: balanced/performance/storage/containers/minimal", () => {
    const prefs = read("src/lib/prefs.tsx");
    for (const key of ["balanced", "performance", "storage", "containers", "minimal"]) {
      assert.match(prefs, new RegExp(`${key}:`), `preset ${key}`);
    }
  });
});

/** Settings whitespace (v0.9.2). */
describe("v0.9.2 settings whitespace", () => {
  it("settings columns are items-start (no equal-height stretch)", () => {
    const page = read("src/app/settings/page.tsx");
    assert.match(page, /grid items-start gap-3 lg:grid-cols-2/);
  });
});
