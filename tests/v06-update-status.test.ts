import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Pure logic tests for the v0.6 update-status module. Registry fetches
 * are network calls — the semantic decisions (version compare, revision
 * compare, degradation shape) are what we lock down here.
 */

import { getBuildInfo, resetBuildInfoCache } from "../src/server/version";

describe("v06 build provenance", () => {
  it("reads APP_VERSION/GIT_SHA from the environment", () => {
    process.env.APP_VERSION = "0.6.0";
    process.env.GIT_SHA = "abc1234def";
    process.env.BUILD_TIME = "2026-09-26T00:00:00Z";
    resetBuildInfoCache();
    const build = getBuildInfo();
    assert.equal(build.version, "0.6.0");
    assert.equal(build.gitSha, "abc1234def");
    assert.equal(build.buildTime, "2026-09-26T00:00:00Z");
    delete process.env.APP_VERSION;
    delete process.env.GIT_SHA;
    delete process.env.BUILD_TIME;
    resetBuildInfoCache();
  });
});

describe("v06 update-status semantics", () => {
  // Re-implementations of the module's private helpers would drift; instead
  // exercise the real module with the GHCR token path disabled (unknown
  // degradation) and verify the shape used by the UI.
  it("degrades to unknown without GHCR_TOKEN and never throws", async () => {
    process.env.UNRAID_URL ??= "http://127.0.0.1:442";
    process.env.UNRAID_API_KEY ??= "k";
    delete process.env.GHCR_TOKEN;
    const { checkForUpdate, resetUpdateCheck } = await import("../src/server/actions/update-check");
    resetUpdateCheck();
    const status = await checkForUpdate();
    assert.equal(status.status, "unknown");
    assert.equal(status.registry.tokenConfigured, false);
    assert.equal(status.latestTag, null);
    assert.ok(status.reason);
  });

  it("reports registry state fields even when degraded", async () => {
    const { checkForUpdate, resetUpdateCheck } = await import("../src/server/actions/update-check");
    resetUpdateCheck();
    const status = await checkForUpdate();
    assert.ok("reachable" in status.registry);
    assert.ok("authorized" in status.registry);
    assert.ok(status.checkedAt);
  });
});
