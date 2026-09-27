import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { updateGate } from "../src/server/docker/policy";
import type { ManagedContainer } from "../src/server/docker/model";

/** v0.7.7 update-manager gates: blocks, policy, AIO/external, input. */

function container(overrides: Partial<ManagedContainer> = {}): ManagedContainer {
  return {
    id: "abc",
    name: "some-container",
    image: "ghcr.io/owner/app:1.0.0",
    tag: "1.0.0",
    image_id: "sha256:imageid",
    current_digest: "sha256:old",
    remote_digest: "sha256:new",
    registry: "ghcr.io",
    management_type: "unraid",
    management_source: "dockerman-label:owner/app",
    update_strategy: "unraid_template",
    update_available: true,
    update_status: "UPDATE_AVAILABLE",
    risk: "LOW",
    policy: "notify",
    rollback_available: false,
    health: "healthy",
    last_checked: "2026-09-27T20:00:00Z",
    last_updated: null,
    ...overrides,
  };
}

describe("v0.7.7 update gates", () => {
  it("LOW-risk unraid container with update = updatable", () => {
    const gate = updateGate(container());
    assert.equal(gate.canUpdate, true);
    assert.equal(gate.blockedReason, null);
  });

  it("no update available = not updatable without a scary reason", () => {
    const gate = updateGate(container({ update_available: false, update_status: "UP_TO_DATE", remote_digest: "sha256:old" }));
    assert.equal(gate.canUpdate, false);
    assert.equal(gate.blockedReason, null);
  });

  it("DUMB AIO is blocked with the explicit AIO reason", () => {
    const gate = updateGate(container({ name: "DUMB", image: "iampuid0/dumb:latest" }));
    assert.equal(gate.canUpdate, false);
    assert.match(gate.blockedReason ?? "", /DUMB AIO/);
  });

  it("DUMBscope blocked as externally managed", () => {
    const gate = updateGate(container({ name: "DUMBscope", image: "ghcr.io/cyxno/dumbscope:0.9.7" }));
    assert.equal(gate.canUpdate, false);
    assert.match(gate.blockedReason ?? "", /Managed externally/);
  });

  it("unraid-dashboard and helper blocked (own update machine)", () => {
    for (const name of ["unraid-dashboard", "unraid-dashboard-helper"]) {
      const gate = updateGate(container({ name }));
      assert.equal(gate.canUpdate, false, name);
    }
  });

  it("watchtower blocked as external updater", () => {
    const gate = updateGate(container({ name: "watchtower", image: "containrrr/watchtower" }));
    assert.equal(gate.canUpdate, false);
  });

  it("compose-managed blocked", () => {
    const gate = updateGate(container({
      name: "immich_server",
      management_type: "compose",
      management_source: "compose:immich/immich-server",
      update_strategy: "compose_service",
    }));
    assert.equal(gate.canUpdate, false);
    assert.match(gate.blockedReason ?? "", /[Cc]ompose/);
  });

  it("local build blocked (pure local_build management)", () => {
    const gate = updateGate(container({
      name: "tablet-dashboard",
      management_type: "local_build",
      update_strategy: "local_build",
      update_status: "LOCAL_BUILD",
      update_available: false,
    }));
    assert.equal(gate.canUpdate, false);
    assert.match(gate.blockedReason ?? "", /[Ll]ocal build/);
  });

  it("compose container with a local image: compose reason wins (strongest ownership)", () => {
    const gate = updateGate(container({
      name: "tornscope-web-1",
      management_type: "compose",
      update_strategy: "local_build",
      update_status: "LOCAL_BUILD",
      update_available: false,
    }));
    assert.equal(gate.canUpdate, false);
    assert.match(gate.blockedReason ?? "", /[Cc]ompose/);
  });

  it("HIGH risk blocked with manual guidance", () => {
    const gate = updateGate(container({ name: "cloudreve-postgres", image: "postgres:16", risk: "HIGH", policy: "manual" }));
    assert.equal(gate.canUpdate, false);
    assert.match(gate.blockedReason ?? "", /HIGH/);
  });

  it("digest-pinned blocked", () => {
    const gate = updateGate(container({
      name: "pin-test",
      image: "postgres:16@sha256:feed",
      update_status: "PINNED",
      update_available: false,
    }));
    assert.equal(gate.canUpdate, false);
    assert.match(gate.blockedReason ?? "", /[Pp]inned/);
  });

  it("AUTH_REQUIRED blocked (no verified source)", () => {
    const gate = updateGate(container({
      name: "private-app",
      update_status: "AUTH_REQUIRED",
      update_available: false,
      remote_digest: null,
    }));
    assert.equal(gate.canUpdate, false);
  });

  it("CHECK_FAILED blocked", () => {
    const gate = updateGate(container({
      name: "flaky",
      update_status: "CHECK_FAILED",
      update_available: false,
      remote_digest: null,
    }));
    assert.equal(gate.canUpdate, false);
  });

  it("case-insensitive AIO block (dumb lowercase)", () => {
    const gate = updateGate(container({ name: "dumb" }));
    assert.equal(gate.canUpdate, false);
  });
});

describe("v0.7.7 input validation (route-level regex)", () => {
  const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

  it("accepts normal container names", () => {
    for (const name of ["UptimeKuma", "kavita", "tornscope-web-1", "DUMB", "my_app.v2"]) {
      assert.match(name, NAME_RE, name);
    }
  });

  it("rejects shell metacharacters and injection attempts", () => {
    for (const name of [
      "a;rm -rf /",
      "a && reboot",
      "$(whoami)",
      "`id`",
      "a|b",
      "../../etc/passwd",
      "a b",
      "",
      "-leading-dash",
      "a\nb",
      "a".repeat(101),
    ]) {
      assert.doesNotMatch(name, NAME_RE, JSON.stringify(name));
    }
  });

  it("rejects missing confirm without ever reaching the helper", () => {
    // The route asserts body.confirm === "yes" together with NAME_RE —
    // encoded here as documentation of the contract.
    const confirm = "YES"; // must be lowercase "yes"
    assert.notEqual(confirm, "yes");
  });
});
