import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * "Latest release" source resolution for the Settings → Updates screen.
 *
 * v1.1.2 regression: without GHCR_TOKEN the route presented the newest
 * LOCALLY present image as "latest release" and — when it equaled the
 * running version — reported "up to date, source: local images", masking
 * the actual remote release. The contract now: a registry answer is
 * authoritative; local images are discovery-only and can never produce
 * "up to date"; no answer at all stays an explicit degraded state.
 */

import { resolveEffectiveRelease } from "../src/server/update/effective-release";
import type { UpdateStatus } from "../src/server/actions/update-check";

function registryStatus(status: UpdateStatus["status"]): UpdateStatus {
  return {
    status,
    reason: status === "unknown" ? "registry unreachable" : undefined,
    latestTag: status === "unknown" ? null : "1.1.2",
    latestManifestDigest: null,
    latestRevisionSha: null,
    checkedAt: "2026-10-02T00:00:00.000Z",
    registry: { tokenConfigured: false, reachable: status !== "unknown", authorized: status !== "unknown", reason: null },
  };
}

const helper = (localVersions: string[], reachable = true) => ({
  reachable,
  localVersions,
  currentVersion: "1.1.0",
  pullAvailable: true,
});

describe("effective release resolution", () => {
  it("prefers the registry answer as the authoritative source", () => {
    const { release, source } = resolveEffectiveRelease(registryStatus("up-to-date"), helper(["1.1.0"]), "1.1.0");
    assert.equal(source, "registry");
    assert.equal(release.status, "up-to-date");
    assert.equal(release.latestTag, "1.1.2");
  });

  it("reports update available when remote is newer than running (1.1.0 → 1.1.2)", () => {
    const { release, source } = resolveEffectiveRelease(registryStatus("available"), helper([]), "1.1.0");
    assert.equal(source, "registry");
    assert.equal(release.status, "available");
    assert.equal(release.latestTag, "1.1.2");
  });

  it("local images never produce 'up to date' — equal local version stays unknown/degraded", () => {
    // THE regression case: running 1.1.0, newest local 1.1.0, no registry answer.
    const { release, source } = resolveEffectiveRelease(registryStatus("unknown"), helper(["1.1.0"]), "1.1.0");
    assert.equal(source, "local-fallback");
    assert.equal(release.status, "unknown", "local equality must NOT report up-to-date");
    assert.equal(release.latestTag, null);
    assert.match(release.reason ?? "", /not an authoritative/);
  });

  it("a newer local image is surfaced as a discovery hint, still non-authoritative", () => {
    const { release, source } = resolveEffectiveRelease(registryStatus("unknown"), helper(["1.1.2", "1.1.0"]), "1.1.0");
    assert.equal(source, "local-fallback");
    assert.equal(release.status, "available");
    assert.equal(release.latestTag, "1.1.2");
    assert.match(release.reason ?? "", /not an authoritative/);
  });

  it("no registry answer and no local discovery stays an explicit unknown", () => {
    const { release, source } = resolveEffectiveRelease(registryStatus("unknown"), helper([], false), "1.1.0");
    assert.equal(source, "none");
    assert.equal(release.status, "unknown");
    assert.equal(release.latestTag, null);
  });
});
