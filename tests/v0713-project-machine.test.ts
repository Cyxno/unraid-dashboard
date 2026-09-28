import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = require(path.join(repoRoot, "helper", "compose.js"));

describe("v0.7.13 compose config parsing (dependency graph, never guessed)", () => {
  it("parses long-syntax depends_on (condition objects)", () => {
    const parsed = compose.parseComposeConfig({
      services: {
        web: { image: "nginx", depends_on: { api: { condition: "service_healthy" }, db: { condition: "service_started" } } },
        api: { image: "api", depends_on: { db: { condition: "service_healthy" } } },
        db: { image: "postgres" },
      },
    });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.dependsOn, { web: ["api", "db"], api: ["db"], db: [] });
    assert.deepEqual([...parsed.services].sort(), ["api", "db", "web"]);
  });

  it("parses short-syntax depends_on (plain lists)", () => {
    const parsed = compose.parseComposeConfig({
      services: { web: { depends_on: ["api"] }, api: {} },
    });
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.dependsOn, { web: ["api"], api: [] });
  });

  it("rejects malformed config instead of inventing a graph", () => {
    assert.equal(compose.parseComposeConfig({}).ok, false);
    assert.equal(compose.parseComposeConfig({ services: {} }).ok, false);
    assert.equal(compose.parseComposeConfig(null).ok, false);
  });

  it("topological order: dependencies first, deterministic", () => {
    const order = compose.topologicalOrder(["web", "api", "db"], { web: ["api"], api: ["db"], db: [] });
    assert.equal(order.ok, true);
    if (order.ok) assert.deepEqual(order.order, ["db", "api", "web"]);
  });

  it("topological order refuses cycles and missing deps", () => {
    const cycle = compose.topologicalOrder(["a", "b"], { a: ["b"], b: ["a"] });
    assert.equal(cycle.ok, false);
    const missing = compose.topologicalOrder(["web"], { web: ["ghost"] });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.reason, /ghost/);
  });

  it("composeArgs supports the config-json action (read-only)", () => {
    const args = compose.composeArgs(
      { project: "stack", workdir: "/mnt/user/appdata/stack", configFiles: ["docker-compose.yml"], service: null },
      "config-json",
    );
    assert.deepEqual(args, ["compose", "--project-name", "stack", "--project-directory", "/mnt/user/appdata/stack", "--file", "docker-compose.yml", "config", "--format", "json"]);
  });
});

describe("v0.7.13 helper project-update machine policy parity (source-level)", () => {
  const helperSource = readFileSync(path.join(repoRoot, "helper", "server.js"), "utf8");

  it("refuses pipeline-owned projects server-side", () => {
    assert.match(helperSource, /pipeline-owned project — dashboard never executes updates here/);
    assert.match(helperSource, /PIPELINE_OWNED_PROJECTS/);
  });

  it("refuses HIGH-risk members in project updates (policy parity with the dashboard)", () => {
    assert.match(helperSource, /isHighRisk/);
    assert.match(helperSource, /postgres\|mysql\|mariadb/);
    assert.match(helperSource, /project contains non-updateable members/);
  });

  it("stops the project on first failure and rolls the failed service back", () => {
    assert.match(helperSource, /project update stopped/);
    assert.match(helperSource, /rolling-back:\$\{service\}/);
  });

  it("never accepts paths or services from the request (project name only)", () => {
    const route = helperSource.slice(helperSource.indexOf("/compose-project-update"));
    assert.match(route, /body\?\.project/);
    assert.doesNotMatch(route, /body\?\.(workdir|configFiles|service|order|services)/);
  });

  it("exposes pre-mutation stale clearing only", () => {
    assert.match(helperSource, /PRE_MUTATION_PHASES/);
    assert.match(helperSource, /post-mutation — needs recovery, not clearing/);
    assert.match(helperSource, /target container is not running — clearing unsafe/);
  });

  it("the clear-stale route never accepts arbitrary job keys", () => {
    const route = helperSource.slice(helperSource.indexOf("/recovery/clear-stale"));
    assert.doesNotMatch(route, /body\?\.job/);
  });

  it("inventory includes snapshot presence without snapshot contents", () => {
    assert.match(helperSource, /snapshotPresent/);
    const snapshotsRoute = helperSource.slice(
      helperSource.indexOf("Read-only list of stored pre-update snapshots"),
      helperSource.indexOf('"/recovery/clear-stale"'),
    );
    assert.match(snapshotsRoute, /NEVER returns snapshot contents/);
    // Presence metadata only: no env material may be returned.
    assert.doesNotMatch(snapshotsRoute, /envLines|\.env\b|snapshot\.env/);
  });
});
