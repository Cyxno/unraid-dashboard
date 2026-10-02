import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

/**
 * Update-status semantics against GHCR. Registry traffic is stubbed at the
 * `fetch` boundary so the suite is deterministic offline; the real module
 * (anonymous-token flow, version compare, revision compare, degradation
 * shapes) is exercised end to end.
 */

import { getBuildInfo, resetBuildInfoCache } from "../src/server/version";
import { resetEnvCache } from "../src/server/env";

type FetchHandler = (url: string, init?: RequestInit) => Response | Promise<Response>;

/** Swaps globalThis.fetch for a stub; returns a restore function. */
function stubFetch(handler: FetchHandler): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Standard GHCR stub: anonymous token granted, 1.1.1 is the latest tag. */
function stubPublicRegistry(): () => void {
  return stubFetch((url) => {
    if (url.includes("/token?scope=")) return jsonResponse({ token: "anon-token" });
    if (url.includes("/tags/list")) return jsonResponse({ tags: ["1.1.1", "1.0.1", "1.0.0"] });
    if (url.includes("/manifests/"))
      return jsonResponse(
        { config: { digest: "sha256:" + "a".repeat(64) } },
        200,
        { "docker-content-digest": "sha256:" + "b".repeat(64) },
      );
    if (url.includes("/blobs/"))
      return jsonResponse({ config: { Labels: { "org.opencontainers.image.revision": "feedc0de" } } });
    return jsonResponse({ message: "not found" }, 404);
  });
}

async function freshCheck() {
  process.env.UNRAID_URL ??= "http://127.0.0.1:442";
  process.env.UNRAID_API_KEY ??= "k";
  const { checkForUpdate, resetUpdateCheck } = await import("../src/server/actions/update-check");
  resetUpdateCheck();
  return checkForUpdate();
}

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
  const restoreFns: (() => void)[] = [];
  afterEach(() => {
    while (restoreFns.length) restoreFns.pop()?.();
    delete process.env.APP_VERSION;
    delete process.env.GIT_SHA;
    delete process.env.GHCR_TOKEN;
    resetBuildInfoCache();
    resetEnvCache();
  });

  it("checks anonymously without GHCR_TOKEN and reports a newer release (public package)", async () => {
    process.env.APP_VERSION = "1.1.0";
    resetBuildInfoCache();
    restoreFns.push(stubPublicRegistry());
    const status = await freshCheck();
    assert.equal(status.status, "available");
    assert.equal(status.latestTag, "1.1.1");
    assert.equal(status.registry.tokenConfigured, false);
    assert.equal(status.registry.reachable, true);
    assert.equal(status.registry.authorized, true);
  });

  it("reports up-to-date when the running version matches the latest tag", async () => {
    process.env.APP_VERSION = "1.1.1";
    resetBuildInfoCache();
    restoreFns.push(stubPublicRegistry());
    const status = await freshCheck();
    assert.equal(status.status, "up-to-date");
    assert.equal(status.latestTag, "1.1.1");
    assert.equal(status.registry.authorized, true);
  });

  it("degrades with a private-package reason when the registry rejects the anonymous check", async () => {
    restoreFns.push(
      stubFetch((url) => {
        if (url.includes("/token?scope=")) return jsonResponse({ token: "anon-token" });
        return jsonResponse({ errors: [{ message: "unauthorized" }] }, 401);
      }),
    );
    const status = await freshCheck();
    assert.equal(status.status, "unknown");
    assert.match(status.reason ?? "", /private/);
    assert.equal(status.registry.tokenConfigured, false);
    assert.equal(status.registry.reachable, true);
    assert.equal(status.registry.authorized, false);
  });

  it("degrades with an offline reason when the registry is unreachable and never throws", async () => {
    restoreFns.push(
      stubFetch(() => {
        throw new Error("getaddrinfo ENOTFOUND ghcr.io");
      }),
    );
    const status = await freshCheck();
    assert.equal(status.status, "unknown");
    assert.match(status.reason ?? "", /unreachable/i);
    assert.equal(status.registry.tokenConfigured, false);
    assert.equal(status.latestTag, null);
  });

  it("uses the configured GHCR_TOKEN when present (tokenConfigured: true)", async () => {
    process.env.GHCR_TOKEN = "configured-token";
    process.env.APP_VERSION = "1.1.0";
    resetBuildInfoCache();
    resetEnvCache();
    let sawAuthHeader = false;
    restoreFns.push(
      stubFetch((url, init) => {
        if (url.includes("/token?scope=")) throw new Error("must not request an anonymous token");
        if (url.includes("/tags/list")) {
          sawAuthHeader = String(new Headers(init?.headers).get("authorization")) === "Bearer configured-token";
          return jsonResponse({ tags: ["1.1.1"] });
        }
        return jsonResponse({});
      }),
    );
    const status = await freshCheck();
    assert.equal(status.status, "available");
    assert.equal(status.registry.tokenConfigured, true);
    assert.ok(sawAuthHeader, "registry calls must bear the configured token");
  });

  it("follows registry pagination to find the newest semver tag", async () => {
    // GHCR pages tags/list at 100 entries; sha tags consume that budget, so
    // the newest semver tag can live on a later page (v1.1.2 regression).
    process.env.APP_VERSION = "1.1.0";
    resetBuildInfoCache();
    restoreFns.push(
      stubFetch((url) => {
        if (url.includes("/token?scope=")) return jsonResponse({ token: "anon-token" });
        if (url.includes("tags/list") && url.includes("last=")) {
          return jsonResponse({ tags: ["1.1.2", "1.1.1"] });
        }
        if (url.includes("tags/list")) {
          return jsonResponse(
            { tags: ["0.9.14", "0.9.9", "sha-abc"] },
            200,
            { link: '</v2/cyxno/unraid-dashboard/tags/list?last=sha-abc&n=100>; rel="next"' },
          );
        }
        return jsonResponse({});
      }),
    );
    const status = await freshCheck();
    assert.equal(status.latestTag, "1.1.2", "the newest tag must be found across pages");
    assert.equal(status.status, "available");
  });

  it("reports registry state fields even when degraded", async () => {
    restoreFns.push(
      stubFetch(() => {
        throw new Error("offline");
      }),
    );
    const status = await freshCheck();
    assert.ok("reachable" in status.registry);
    assert.ok("authorized" in status.registry);
    assert.ok(status.checkedAt);
  });

  it("force bypasses the background cache; background checks keep using it", async () => {
    process.env.APP_VERSION = "1.1.0";
    resetBuildInfoCache();
    let tags = ["1.1.1"];
    let registryCalls = 0;
    restoreFns.push(
      stubFetch((url) => {
        if (url.includes("/token?scope=")) return jsonResponse({ token: "anon-token" });
        if (url.includes("/tags/list")) {
          registryCalls += 1;
          return jsonResponse({ tags });
        }
        return jsonResponse({});
      }),
    );
    const first = await freshCheck();
    assert.equal(first.latestTag, "1.1.1");

    // The remote release moves; background (non-forced) checks serve the cache.
    tags = ["9.9.9"];
    const { checkForUpdate } = await import("../src/server/actions/update-check");
    const cached = await checkForUpdate();
    assert.equal(cached.latestTag, "1.1.1", "background check must serve the cached answer");
    assert.equal(registryCalls, 1, "background check must not hit the registry");

    // A manual check (force) performs a fresh remote lookup.
    const forced = await checkForUpdate({ force: true });
    assert.equal(forced.latestTag, "9.9.9", "forced check must see the new remote release");
    assert.equal(forced.status, "available");
    assert.equal(registryCalls, 2);
  });
});
