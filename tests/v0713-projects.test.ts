import assert from "node:assert/strict";
import { describe, it } from "node:test";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import {
  buildProjectPlan,
  buildProjects,
  hashPlan,
  topologicalServiceOrder,
  type ComposeProject,
} from "../src/server/docker/projects";
import { updateGate } from "../src/server/docker/policy";
import type { ManagedContainer } from "../src/server/docker/model";

function container(overrides: Partial<ManagedContainer> & { name: string; service: string }): ManagedContainer {
  const { service, name, ...rest } = overrides;
  return {
    id: `id-${name}`,
    name,
    image: "ghcr.io/owner/app:1.0.0",
    tag: "1.0.0",
    image_id: "sha256:imageid",
    current_digest: "sha256:aaaa",
    remote_digest: "sha256:bbbb",
    registry: "ghcr.io",
    management_type: "compose",
    management_source: `compose:stack/${service}`,
    update_strategy: "compose_service",
    update_available: true,
    update_status: "UPDATE_AVAILABLE",
    risk: "LOW",
    policy: "notify",
    rollback_available: true,
    externallyManaged: false,
    ownership: { management: null, policy: null, risk: null, pipeline: { repo: null, deployer: null, sha: null, ref: null } },
    provenance: { state: "registry_ahead", image_id: "sha256:imageid", local_digest: "sha256:aaaa", registry_digest: "sha256:bbbb", locally_built: false, note: null },
    rollback: { ready: true, level: "ready", snapshot_present: true, image_present: true, last_known_good: null, validated_at: null },
    autoEligible: false,
    autoEligibilityReasons: [],
    health: "healthy",
    last_checked: "2026-09-28T00:00:00Z",
    last_updated: null,
    ...rest,
  };
}

function project(services: ManagedContainer[], overrides: Partial<ComposeProject> = {}): ComposeProject {
  return {
    name: "stack",
    workingDir: "/mnt/user/appdata/stack",
    configFiles: ["docker-compose.yml"],
    services: services.map((entry) => ({
      service: entry.management_source.split("/")[1] ?? entry.name,
      containers: [entry.name],
      container: entry,
    })),
    networks: [],
    sharedVolumes: [],
    pipelineOwned: false,
    healthState: "healthy",
    ...overrides,
  };
}

const allowAll = () => ({ canUpdate: true, blockedReason: null });

describe("v0.7.13 project inventory", () => {
  it("groups compose containers into projects by management_source", () => {
    const projects = buildProjects([
      container({ name: "web-1", service: "web" }),
      container({ name: "api-1", service: "api" }),
      container({ name: "other", service: "x", management_source: "compose:other/x", management_type: "compose" }),
      container({ name: "unmanaged", service: "y", management_type: "unraid", management_source: "dockerman-label:foo" }),
    ]);
    const names = projects.map((entry) => entry.name).sort();
    assert.deepEqual(names, ["other", "stack"]);
    const stack = projects.find((entry) => entry.name === "stack")!;
    assert.equal(stack.services.length, 2);
  });

  it("pipeline-owned projects are flagged", () => {
    const projects = buildProjects([
      container({ name: "tornscope-web-1", service: "web", management_type: "pipeline_owned", management_source: "pipeline project list:tornscope/web", update_available: false, update_status: "LOCAL_BUILD" }),
    ]);
    assert.equal(projects[0]?.pipelineOwned, true);
  });

  it("aggregates health state across services", () => {
    const projects = buildProjects([
      container({ name: "a", service: "a", health: "healthy" }),
      container({ name: "b", service: "b", health: "unhealthy" }),
    ]);
    assert.equal(projects[0]?.healthState, "degraded");
  });
});

describe("v0.7.13 dependency ordering (compose config only)", () => {
  it("orders dependencies before dependents", () => {
    const result = topologicalServiceOrder(
      ["web", "api", "db"],
      { web: ["api"], api: ["db"], db: [] },
    );
    assert.ok(result.order);
    if (result.order) {
      assert.ok(result.order.indexOf("db") < result.order.indexOf("api"));
      assert.ok(result.order.indexOf("api") < result.order.indexOf("web"));
    }
  });

  it("refuses an ambiguous graph: edge to a service without a container", () => {
    const result = topologicalServiceOrder(
      ["web", "api"],
      { web: ["api"], api: ["metrics-sidecar"] },
    );
    assert.equal(result.order, null);
    if (!result.order) assert.match(result.reason, /metrics-sidecar/);
  });

  it("refuses a dependency cycle instead of inventing an order", () => {
    const result = topologicalServiceOrder(
      ["a", "b"],
      { a: ["b"], b: ["a"] },
    );
    assert.equal(result.order, null);
    if (!result.order) assert.match(result.reason, /cycle/);
  });

  it("never invents order from names alone (no depends_on = plain list)", () => {
    const result = topologicalServiceOrder(["zebra", "alpha"], {});
    assert.ok(result.order);
    if (result.order) assert.deepEqual(result.order, ["alpha", "zebra"]); // deterministic, not semantic
  });
});

describe("v0.7.13 project update plan (read-only)", () => {
  it("orders updateable services by the configured dependency graph", () => {
    const plan = buildProjectPlan({
      project: project([
        container({ name: "stack-web-1", service: "web" }),
        container({ name: "stack-api-1", service: "api" }),
        container({ name: "stack-db-1", service: "db" }),
      ]),
      dependsOn: { web: ["api"], api: ["db"], db: [] },
      gate: allowAll,
    });
    assert.equal(plan.supported, true);
    assert.deepEqual(
      plan.order.map((step) => step.service),
      ["db", "api", "web"],
    );
    assert.equal(plan.mutationAllowed, true);
  });

  it("refuses the WHOLE project when one member is HIGH risk", () => {
    const plan = buildProjectPlan({
      project: project([
        container({ name: "stack-web-1", service: "web" }),
        container({ name: "stack-db-1", service: "db", risk: "HIGH" }),
      ]),
      dependsOn: { web: ["db"], db: [] },
      gate: allowAll,
    });
    assert.equal(plan.mutationAllowed, false);
    assert.match(plan.blocked.find((entry) => entry.service === "db")?.reason ?? "", /HIGH risk/);
  });

  it("refuses the WHOLE project when one member is pipeline-owned", () => {
    const plan = buildProjectPlan({
      project: project([
        container({ name: "stack-web-1", service: "web" }),
        container({ name: "stack-ext-1", service: "ext", management_type: "pipeline_owned", externallyManaged: true }),
      ]),
      dependsOn: { web: [], ext: [] },
      gate: allowAll,
    });
    assert.equal(plan.mutationAllowed, false);
    assert.match(plan.blocked.find((entry) => entry.service === "ext")?.reason ?? "", /pipeline/);
  });

  it("refuses when the helper reports an ambiguous dependency graph", () => {
    const plan = buildProjectPlan({
      project: project([container({ name: "stack-web-1", service: "web" })]),
      dependsOn: { web: ["missing-service"] },
      gate: allowAll,
    });
    assert.equal(plan.supported, false);
    assert.match(plan.unsupportedReason ?? "", /ambiguous|missing-service/);
    assert.equal(plan.mutationAllowed, false);
  });

  it("already-up-to-date members are skipped, not treated as blockers", () => {
    const plan = buildProjectPlan({
      project: project([
        container({ name: "stack-web-1", service: "web", update_available: false, update_status: "UP_TO_DATE", remote_digest: "sha256:aaaa" }),
        container({ name: "stack-api-1", service: "api" }),
      ]),
      dependsOn: { web: ["api"], api: [] },
      gate: (entry) => updateGate(entry),
    });
    assert.equal(plan.mutationAllowed, true);
    assert.deepEqual(plan.order.map((step) => step.service), ["api"]);
    assert.equal(plan.blocked.length, 1);
    assert.match(plan.blocked[0]!.reason, /up to date/);
  });

  it("rollback readiness gates the plan", () => {
    const plan = buildProjectPlan({
      project: project([
        container({
          name: "stack-web-1",
          service: "web",
          rollback: { ready: false, level: "not_ready", snapshot_present: false, image_present: false, last_known_good: null, validated_at: null },
          rollback_available: false,
        }),
      ]),
      dependsOn: { web: [] },
      gate: (entry) => updateGate(entry),
    });
    assert.equal(plan.mutationAllowed, false);
    assert.equal(plan.rollbackReady, false);
  });

  it("plan hash is stable and changes with the order", () => {
    const base = { project: "stack", steps: [{ service: "db" }, { service: "web" }], blocked: [] };
    const other = { project: "stack", steps: [{ service: "web" }, { service: "db" }], blocked: [] };
    assert.equal(hashPlan(base), hashPlan({ ...base }));
    assert.notEqual(hashPlan(base), hashPlan(other));
  });
});
