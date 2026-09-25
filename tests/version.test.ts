import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getBuildInfo, resetBuildInfoCache } from "../src/server/version";

describe("build provenance", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.APP_VERSION;
    delete process.env.GIT_SHA;
    delete process.env.BUILD_TIME;
    delete process.env.IMAGE_REF;
    resetBuildInfoCache();
  });

  it("falls back to the baked package version without build env", () => {
    // next.config.ts bakes APP_VERSION_FALLBACK at build time; simulate it.
    process.env.APP_VERSION_FALLBACK = "0.3.0";
    const info = getBuildInfo();
    assert.equal(info.version, "0.3.0");
    assert.equal(info.gitSha, null);
    assert.equal(info.buildTime, null);
    assert.equal(info.imageRef, null);
  });

  it("reports unknown when neither runtime nor baked version exists", () => {
    delete process.env.APP_VERSION_FALLBACK;
    assert.equal(getBuildInfo().version, "unknown");
  });

  it("exposes only the whitelisted build values", () => {
    process.env.APP_VERSION = "9.9.9-test";
    process.env.GIT_SHA = "abc1234def5678";
    process.env.BUILD_TIME = "2026-09-25T00:00:00Z";
    process.env.IMAGE_REF = "ghcr.io/cyxno/unraid-dashboard:9.9.9-test";
    // Unrelated env must never leak into build info.
    process.env.UNRAID_API_KEY = "super-secret";
    const info = getBuildInfo();
    assert.equal(info.version, "9.9.9-test");
    assert.equal(info.gitSha, "abc1234def5678");
    assert.equal(info.buildTime, "2026-09-25T00:00:00Z");
    assert.equal(info.imageRef, "ghcr.io/cyxno/unraid-dashboard:9.9.9-test");
    const serialized = JSON.stringify(info);
    assert.ok(!serialized.includes("super-secret"));
  });
});
