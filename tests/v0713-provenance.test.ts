import assert from "node:assert/strict";
import { describe, it } from "node:test";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import {
  buildManagedContainer,
  classifyManagement,
  deriveProvenance,
  parseOwnershipLabels,
  pipelineOwnedProjects,
  type CheckOutcome,
  type ContainerFacts,
} from "../src/server/docker/model";
import { updateGate } from "../src/server/docker/policy";

function facts(overrides: Partial<ContainerFacts> = {}): ContainerFacts {
  return {
    id: "abc123",
    name: "some-container",
    image: "ghcr.io/owner/app:1.0.0",
    state: "running",
    status: "Up 2 hours",
    health: "healthy",
    imageId: "sha256:imageid",
    repoDigests: ["ghcr.io/owner/app@sha256:aaaa"],
    created: "2026-09-26T00:00:00Z",
    networks: [],
    volumeSources: [],
    labels: {},
    ...overrides,
  };
}

describe("v0.7.13 registry/image provenance", () => {
  it("synced when the running RepoDigest equals the registry digest", () => {
    const check: CheckOutcome = { status: "UP_TO_DATE", remoteDigest: "sha256:aaaa", localDigest: "sha256:aaaa" };
    const provenance = deriveProvenance(facts(), check);
    assert.equal(provenance.state, "synced");
    assert.equal(provenance.registry_digest, "sha256:aaaa");
    assert.equal(provenance.locally_built, false);
  });

  it("registry_ahead when the tag moved — never labeled a compromise", () => {
    const check: CheckOutcome = { status: "UPDATE_AVAILABLE", remoteDigest: "sha256:bbbb", localDigest: "sha256:aaaa" };
    const provenance = deriveProvenance(facts(), check);
    assert.equal(provenance.state, "registry_ahead");
    assert.ok(!/compromis|attack|malicious/i.test(provenance.note ?? ""));
    assert.match(provenance.note ?? "", /newer build/);
  });

  it("local_build when no RepoDigests exist", () => {
    const provenance = deriveProvenance(facts({ repoDigests: [] }), undefined);
    assert.equal(provenance.state, "local_build");
    assert.equal(provenance.locally_built, true);
  });

  it("auth_required propagates the reason", () => {
    const check: CheckOutcome = { status: "AUTH_REQUIRED", remoteDigest: null, localDigest: "sha256:aaaa", reason: "ghcr denied" };
    const provenance = deriveProvenance(facts(), check);
    assert.equal(provenance.state, "auth_required");
    assert.equal(provenance.note, "ghcr denied");
  });

  it("unknown without a check", () => {
    const provenance = deriveProvenance(facts(), undefined);
    assert.equal(provenance.state, "unknown");
  });

  it("carries the running image id and local digest", () => {
    const provenance = deriveProvenance(facts(), undefined);
    assert.equal(provenance.image_id, "sha256:imageid");
    assert.equal(provenance.local_digest, "sha256:aaaa");
  });
});

describe("v0.7.13 pipeline-owned classification", () => {
  it("default pipeline list contains tornscope", () => {
    assert.deepEqual(pipelineOwnedProjects(), ["tornscope"]);
  });

  it("compose project on the pipeline list classifies pipeline_owned", () => {
    const result = classifyManagement(
      facts({
        name: "tornscope-api-1",
        image: "tornscope-api:latest",
        labels: { "com.docker.compose.project": "tornscope", "com.docker.compose.service": "api" },
      }),
      [],
    );
    assert.equal(result.management_type, "pipeline_owned");
    assert.equal(result.update_strategy, "manual");
  });

  it("explicit com.cyxno.management=pipeline label wins over compose", () => {
    const result = classifyManagement(
      facts({
        name: "some-stack-web",
        labels: {
          "com.cyxno.management": "pipeline",
          "com.docker.compose.project": "some-stack",
          "com.docker.compose.service": "web",
        },
      }),
      [],
    );
    assert.equal(result.management_type, "pipeline_owned");
  });

  it("plain compose projects are NOT pipeline-owned", () => {
    const result = classifyManagement(
      facts({
        name: "immich_server",
        labels: { "com.docker.compose.project": "immich", "com.docker.compose.service": "immich-server" },
      }),
      [],
    );
    assert.equal(result.management_type, "compose");
  });

  it("pipeline-owned containers are never updateable through the gate", () => {
    const built = buildManagedContainer({
      facts: facts({
        name: "tornscope-web-1",
        image: "tornscope-web:latest",
        repoDigests: [],
        labels: { "com.docker.compose.project": "tornscope", "com.docker.compose.service": "web" },
      }),
      customDeployContainers: [],
      extraHighRisk: [],
      checkedAt: "2026-09-28T00:00:00Z",
    });
    assert.equal(built.management_type, "pipeline_owned");
    assert.equal(built.externallyManaged, true);
    const gate = updateGate(built);
    assert.equal(gate.canUpdate, false);
    assert.match(gate.blockedReason ?? "", /external deployment pipeline/);
  });
});

describe("v0.7.13 ownership labels (declarative metadata only)", () => {
  it("parses valid labels and ignores unknown values", () => {
    const ownership = parseOwnershipLabels(
      facts({
        labels: {
          "com.cyxno.management": "pipeline",
          "com.cyxno.update.policy": "manual",
          "com.cyxno.update.risk": "high",
          "com.cyxno.pipeline.repo": "Cyxno/tornscope",
          "com.cyxno.pipeline.sha": "abc123",
        },
      }),
    );
    assert.equal(ownership.management, "pipeline");
    assert.equal(ownership.policy, "manual");
    assert.equal(ownership.risk, "HIGH");
    assert.equal(ownership.pipeline.repo, "Cyxno/tornscope");
    assert.equal(ownership.pipeline.sha, "abc123");
  });

  it("a HIGH risk label RAISES a LOW-risk container", () => {
    const built = buildManagedContainer({
      facts: facts({ labels: { "com.cyxno.update.risk": "high" } }),
      customDeployContainers: [],
      extraHighRisk: [],
      checkedAt: "2026-09-28T00:00:00Z",
    });
    assert.equal(built.risk, "HIGH");
    assert.equal(built.policy, "manual");
  });

  it("labels never LOWER the server risk classification", () => {
    const built = buildManagedContainer({
      facts: facts({
        name: "postgres-primary",
        labels: { "com.cyxno.update.risk": "low" },
      }),
      customDeployContainers: [],
      extraHighRisk: [],
      checkedAt: "2026-09-28T00:00:00Z",
    });
    assert.equal(built.risk, "HIGH");
  });

  it("a manual policy label tightens notify but never loosens manual", () => {
    const tightened = buildManagedContainer({
      facts: facts({ labels: { "com.cyxno.update.policy": "manual" } }),
      customDeployContainers: [],
      extraHighRisk: [],
      checkedAt: "2026-09-28T00:00:00Z",
    });
    assert.equal(tightened.policy, "manual");
    const loosened = buildManagedContainer({
      facts: facts({
        name: "postgres-primary",
        labels: { "com.cyxno.update.policy": "auto" },
      }),
      customDeployContainers: [],
      extraHighRisk: [],
      checkedAt: "2026-09-28T00:00:00Z",
    });
    assert.equal(loosened.policy, "manual");
  });
});

describe("v0.7.13 rollback readiness", () => {
  it("not_ready without a resolvable image — mutation refused", () => {
    const built = buildManagedContainer({
      facts: facts({ imageId: null }),
      customDeployContainers: [],
      extraHighRisk: [],
      checkedAt: "2026-09-28T00:00:00Z",
    });
    assert.equal(built.rollback.level, "not_ready");
    assert.equal(built.rollback.ready, false);
    assert.equal(built.rollback_available, false);
    const gate = updateGate(built);
    assert.equal(gate.canUpdate, false);
    assert.match(gate.blockedReason ?? "", /Rollback not ready/);
  });

  it("unproven (no snapshot yet) still allows a first update", () => {
    const built = buildManagedContainer({
      facts: facts({ snapshotPresent: false }),
      customDeployContainers: [],
      extraHighRisk: [],
      check: { status: "UPDATE_AVAILABLE", remoteDigest: "sha256:bbbb", localDigest: "sha256:aaaa" },
      checkedAt: "2026-09-28T00:00:00Z",
    });
    assert.equal(built.rollback.level, "unproven");
    assert.equal(built.rollback.ready, true);
    assert.equal(built.update_available, true);
    assert.equal(updateGate(built).canUpdate, true);
  });

  it("ready when a pre-update snapshot exists", () => {
    const built = buildManagedContainer({
      facts: facts({ snapshotPresent: true }),
      customDeployContainers: [],
      extraHighRisk: [],
      checkedAt: "2026-09-28T00:00:00Z",
    });
    assert.equal(built.rollback.level, "ready");
    assert.equal(built.rollback_available, true);
  });

  it("history fills last_known_good and validated_at", () => {
    const built = buildManagedContainer({
      facts: facts({ snapshotPresent: true }),
      customDeployContainers: [],
      extraHighRisk: [],
      checkedAt: "2026-09-28T00:00:00Z",
      lastKnownGood: { image: "ghcr.io/owner/app:0.9.9", at: "2026-09-20T10:00:00Z" },
    });
    assert.equal(built.rollback.last_known_good, "ghcr.io/owner/app:0.9.9");
    assert.equal(built.rollback.validated_at, "2026-09-20T10:00:00Z");
  });
});
