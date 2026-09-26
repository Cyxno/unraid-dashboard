import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildManagedContainer,
  classifyManagement,
  classifyRisk,
  compareDigests,
  defaultPolicyFor,
  localDigestOf,
  parseImageRef,
  type ContainerFacts,
} from "../src/server/docker/model";

/** Facts factory: bare container with overrides. */
function facts(overrides: Partial<ContainerFacts> = {}): ContainerFacts {
  return {
    id: "abc123",
    name: "some-container",
    image: "ghcr.io/owner/app:1.0.0",
    state: "running",
    status: "Up 2 hours",
    health: null,
    imageId: "sha256:imageid",
    repoDigests: ["ghcr.io/owner/app@sha256:aaaa"],
    created: "2026-09-26T00:00:00Z",
    labels: {},
    ...overrides,
  };
}

describe("v0.7.6 image reference parsing", () => {
  it("parses ghcr.io images", () => {
    const parsed = parseImageRef("ghcr.io/cyxno/unraid-dashboard:0.7.5");
    assert.deepEqual(parsed, { registry: "ghcr.io", repo: "cyxno/unraid-dashboard", tag: "0.7.5", digestPin: null });
  });

  it("puts bare docker hub images under library/", () => {
    const parsed = parseImageRef("prom/prometheus:latest");
    assert.equal(parsed.registry, "docker.io");
    assert.equal(parsed.repo, "prom/prometheus");
    const bare = parseImageRef("mysql:8");
    assert.equal(bare.repo, "library/mysql");
    assert.equal(bare.tag, "8");
  });

  it("keeps lscr.io and gcr.io hosts", () => {
    assert.equal(parseImageRef("lscr.io/linuxserver/kavita:1.2").registry, "lscr.io");
    assert.equal(parseImageRef("gcr.io/cadvisor/cadvisor:latest").registry, "gcr.io");
  });

  it("detects digest pins", () => {
    const parsed = parseImageRef("postgres:16@sha256:abcd");
    assert.equal(parsed.digestPin, "sha256:abcd");
    assert.equal(parsed.tag, "16");
  });

  it("treats org/name without registry as docker.io", () => {
    const parsed = parseImageRef("phasecorex/red-discordbot:full");
    assert.equal(parsed.registry, "docker.io");
  });
});

describe("v0.7.6 management classification (metadata-based, never name-based)", () => {
  it("compose labels win and pick compose_service", () => {
    const result = classifyManagement(
      facts({
        name: "immich_server",
        labels: { composeProject: "immich", composeService: "immich-server", composeWorkdir: "/boot/config/plugins/compose.manager/projects/Immich" },
      }),
      [],
    );
    assert.equal(result.management_type, "compose");
    assert.equal(result.update_strategy, "compose_service");
  });

  it("compose with a locally built image keeps compose management but local_build strategy", () => {
    const result = classifyManagement(
      facts({
        name: "tornscope-web-1",
        image: "tornscope-web:latest",
        repoDigests: [],
        labels: { composeProject: "tornscope", composeService: "web" },
      }),
      [],
    );
    assert.equal(result.management_type, "compose");
    assert.equal(result.update_strategy, "local_build");
  });

  it("unraid dockerman label picks unraid_template", () => {
    const result = classifyManagement(
      facts({ name: "Kavita", labels: { unraidManaged: "dockerman" } }),
      [],
    );
    assert.equal(result.management_type, "unraid");
    assert.equal(result.update_strategy, "unraid_template");
  });

  it("custom deploy comes from operator config, not guessing", () => {
    const result = classifyManagement(facts({ name: "DUMBscope" }), ["DUMBscope"]);
    assert.equal(result.management_type, "custom_deploy");
    assert.equal(result.update_strategy, "deploy_script");
  });

  it("unclassified containers without registry digests are local_build", () => {
    const result = classifyManagement(
      facts({ name: "tablet-dashboard", image: "tablet-dashboard:latest", repoDigests: [] }),
      [],
    );
    assert.equal(result.management_type, "local_build");
    assert.equal(result.update_strategy, "local_build");
  });

  it("registry-digest containers without ownership evidence are standalone", () => {
    const result = classifyManagement(facts({ name: "Dozzle", image: "amir20/dozzle:latest" }), []);
    assert.equal(result.management_type, "standalone");
    assert.equal(result.update_strategy, "registry_recreate");
  });

  it("never classifies by name alone: same name, different metadata, different result", () => {
    const compose = classifyManagement(facts({ name: "app", labels: { composeProject: "p", composeService: "app" } }), ["app"]);
    const unraid = classifyManagement(facts({ name: "app", labels: { unraidManaged: "dockerman" } }), ["app"]);
    assert.equal(compose.management_type, "compose");
    assert.equal(unraid.management_type, "unraid");
  });
});

describe("v0.7.6 digest comparison (Phase D)", () => {
  it("up-to-date when local index digest equals remote", () => {
    const outcome = compareDigests("sha256:same", "sha256:same");
    assert.equal(outcome.status, "UP_TO_DATE");
  });

  it("update available when digests differ (multi-arch index digest)", () => {
    const outcome = compareDigests("sha256:old", "sha256:new");
    assert.equal(outcome.status, "UPDATE_AVAILABLE");
  });

  it("localDigestOf reads the RepoDigest", () => {
    assert.equal(localDigestOf(facts()), "sha256:aaaa");
    assert.equal(localDigestOf(facts({ repoDigests: [] })), null);
  });
});

describe("v0.7.6 risk and policy (Phase H)", () => {
  it("databases, auth and core networking are HIGH with manual policy", () => {
    for (const name of ["cloudreve-postgres", "tornscope-postgres-1", "Authelia", "Nginx-Proxy-Manager-Official", "AdGuard-Home-Unbound", "mysql"]) {
      assert.equal(classifyRisk(name, "image", []), "HIGH", name);
      assert.equal(defaultPolicyFor("HIGH"), "manual");
    }
  });

  it("content servers are MEDIUM with notify policy", () => {
    assert.equal(classifyRisk("kavita", "lscr.io/linuxserver/kavita", []), "MEDIUM");
    assert.equal(classifyRisk("immich_server", "ghcr.io/immich-app/immich-server", []), "MEDIUM");
    assert.equal(defaultPolicyFor("MEDIUM"), "notify");
  });

  it("operator extra-high-risk names override", () => {
    assert.equal(classifyRisk("my-service", "image", ["my-service"]), "HIGH");
  });

  it("typical tools are LOW", () => {
    assert.equal(classifyRisk("Dozzle", "amir20/dozzle", []), "LOW");
    assert.equal(defaultPolicyFor("LOW"), "notify");
  });
});

describe("v0.7.6 full model build", () => {
  it("joins facts + check into the managed model and strips secrets", () => {
    const model = buildManagedContainer({
      facts: facts({ name: "Dozzle", image: "amir20/dozzle:latest" }),
      customDeployContainers: [],
      extraHighRisk: [],
      check: compareDigests("sha256:old", "sha256:new"),
      checkedAt: "2026-09-26T20:00:00Z",
    });
    assert.equal(model.update_status, "UPDATE_AVAILABLE");
    assert.equal(model.update_available, true);
    assert.equal(model.management_type, "standalone");
    assert.equal(model.policy, "notify");
    assert.equal(model.registry, "docker.io");
    const json = JSON.stringify(model);
    assert.ok(!json.toLowerCase().includes("token"));
    assert.ok(!json.toLowerCase().includes("api_key"));
  });

  it("pins, local builds and auth-required statuses win over comparisons", () => {
    const pinned = buildManagedContainer({
      facts: facts({ image: "postgres:16@sha256:feed" }),
      customDeployContainers: [],
      extraHighRisk: [],
      check: { status: "UPDATE_AVAILABLE", remoteDigest: "sha256:x", localDigest: "sha256:y" },
      checkedAt: "now",
    });
    assert.equal(pinned.update_status, "PINNED");
    assert.equal(pinned.update_available, false);

    const localBuild = buildManagedContainer({
      facts: facts({ image: "tablet-dashboard:latest", repoDigests: [] }),
      customDeployContainers: [],
      extraHighRisk: [],
      checkedAt: "now",
    });
    assert.equal(localBuild.update_status, "LOCAL_BUILD");

    const auth = buildManagedContainer({
      facts: facts({ name: "private", image: "ghcr.io/me/private:1", repoDigests: ["ghcr.io/me/private@sha256:zzz"] }),
      customDeployContainers: [],
      extraHighRisk: [],
      check: { status: "AUTH_REQUIRED", remoteDigest: null, localDigest: null, reason: "private" },
      checkedAt: "now",
    });
    assert.equal(auth.update_status, "AUTH_REQUIRED");
  });
});
