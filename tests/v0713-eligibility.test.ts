import assert from "node:assert/strict";
import { describe, it } from "node:test";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import { computeAutoEligibility, pilotAutoEnabled, pilotAllowlist } from "../src/server/update/eligibility";
import type { ManagedContainer } from "../src/server/docker/model";

function container(overrides: Partial<ManagedContainer> = {}): ManagedContainer {
  return {
    id: "abc",
    name: "some-container",
    image: "ghcr.io/owner/app:1.0.0",
    tag: "1.0.0",
    image_id: "sha256:imageid",
    current_digest: "sha256:aaaa",
    remote_digest: "sha256:bbbb",
    registry: "ghcr.io",
    management_type: "unraid",
    management_source: "dockerman-label:owner/app",
    update_strategy: "unraid_template",
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
    ...overrides,
  };
}

const base = {
  manualSuccesses: 5,
  rollbackCount: 0,
  pilotAllowlist: ["some-container"],
};

describe("v0.7.13 auto-update eligibility (no scheduler ships)", () => {
  it("a proven LOW-risk container with healthcheck + allowlist is eligible", () => {
    const result = computeAutoEligibility({ container: container(), ...base });
    assert.equal(result.eligible, true);
    assert.deepEqual(result.reasons, []);
  });

  it("fewer than 3 successful manual updates disqualify", () => {
    const result = computeAutoEligibility({ container: container(), ...base, manualSuccesses: 2 });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((reason) => reason.includes("2 successful manual update")));
  });

  it("any rollback on record disqualifies", () => {
    const result = computeAutoEligibility({ container: container(), ...base, rollbackCount: 1 });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((reason) => /rollback/.test(reason)));
  });

  it("missing healthcheck disqualifies (no objective verification)", () => {
    const result = computeAutoEligibility({ container: container({ health: null }), ...base });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((reason) => /healthcheck/.test(reason)));
  });

  it("HIGH/MEDIUM risk disqualifies", () => {
    const high = computeAutoEligibility({ container: container({ risk: "HIGH", policy: "manual" }), ...base });
    const medium = computeAutoEligibility({ container: container({ risk: "MEDIUM" }), ...base });
    assert.equal(high.eligible, false);
    assert.equal(medium.eligible, false);
  });

  it("pipeline-owned or externally managed never qualify", () => {
    const pipeline = computeAutoEligibility({
      container: container({ management_type: "pipeline_owned", externallyManaged: true }),
      ...base,
    });
    assert.equal(pipeline.eligible, false);
    assert.ok(pipeline.reasons.some((reason) => /externally managed/.test(reason)));
  });

  it("without a proven snapshot disqualifies", () => {
    const result = computeAutoEligibility({
      container: container({ rollback: { ready: true, level: "unproven", snapshot_present: false, image_present: true, last_known_good: null, validated_at: null } }),
      ...base,
    });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((reason) => /snapshot/.test(reason)));
  });

  it("outside the pilot allowlist disqualifies", () => {
    const result = computeAutoEligibility({ container: container(), ...base, pilotAllowlist: [] });
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.some((reason) => /pilot allowlist/.test(reason)));
  });

  it("pilot auto is disabled by default even with an allowlist", () => {
    process.env.PILOT_AUTO_CONTAINERS = "some-container";
    try {
      delete process.env.PILOT_AUTO_ENABLED;
      assert.equal(pilotAutoEnabled(), false);
      assert.deepEqual(pilotAllowlist(), ["some-container"]);
      process.env.PILOT_AUTO_ENABLED = "true";
      assert.equal(pilotAutoEnabled(), true);
    } finally {
      delete process.env.PILOT_AUTO_CONTAINERS;
      delete process.env.PILOT_AUTO_ENABLED;
    }
  });

  it("pilot auto cannot enable without an allowlist", () => {
    delete process.env.PILOT_AUTO_CONTAINERS;
    process.env.PILOT_AUTO_ENABLED = "true";
    try {
      assert.equal(pilotAutoEnabled(), false);
    } finally {
      delete process.env.PILOT_AUTO_ENABLED;
    }
  });
});
