import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const workflow = fs.readFileSync(path.join(ROOT, ".github", "workflows", "docker-publish.yml"), "utf8");
const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");

describe("Fase 4/18: build channel semantics — semver is never a branch name", () => {
  test("release build: version = tag (package equal), channel = release", () => {
    const channel = process.env.BUILD_CHANNEL === "main" ? "main" : "release";
    assert.ok(["release", "main"].includes(channel));
    // The contract test pins package.json == tag version; the workflow takes
    // the release version from the tag, so both equal the package semver.
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  });

  test("main build: workflow computes version from package.json, not the ref name", () => {
    // The provenance step must read package.json for main builds...
    assert.match(workflow, /VERSION=\$\(node -p 'require\("\.\/package\.json"\)\.version'\)/);
    // ...branch the channel explicitly...
    assert.match(workflow, /channel=main/);
    assert.match(workflow, /channel=release/);
    // ...and the build-args must carry APP_VERSION from the provenance step.
    assert.match(workflow, /APP_VERSION=\$\{\{ steps\.ver\.outputs\.version \}\}/);
    assert.match(workflow, /BUILD_CHANNEL=\$\{\{ steps\.ver\.outputs\.channel \}\}/);
    // and must never push a raw branch name in as the app version anymore.
    assert.doesNotMatch(workflow, /version=\$\{GITHUB_REF_NAME#v\}" >> "\$GITHUB_OUTPUT"\n\s+else/);
  });

  test("Dockerfile bakes BUILD_CHANNEL and labels version from APP_VERSION", () => {
    assert.match(dockerfile, /ARG BUILD_CHANNEL=release/);
    assert.match(dockerfile, /org\.opencontainers\.image\.version=\$\{APP_VERSION\}/);
    assert.match(dockerfile, /org\.cyxno\.image\.channel=\$\{BUILD_CHANNEL\}/);
  });
});

describe("Fase 20: runtime version reporting contract", () => {
  test("getBuildInfo exposes version + channel + sha + buildTime", async () => {
    const { getBuildInfo, resetBuildInfoCache } = await import("../src/server/version");
    process.env.APP_VERSION = "1.3.17";
    process.env.BUILD_CHANNEL = "main";
    process.env.GIT_SHA = "abc1234";
    process.env.BUILD_TIME = "2026-10-05T00:00:00Z";
    resetBuildInfoCache();
    const info = getBuildInfo();
    assert.equal(info.version, "1.3.17");
    assert.equal(info.channel, "main");
    assert.equal(info.gitSha, "abc1234");
    assert.equal(info.buildTime, "2026-10-05T00:00:00Z");
    process.env.BUILD_CHANNEL = "release";
    resetBuildInfoCache();
    assert.equal(getBuildInfo().channel, "release");
    assert.match(getBuildInfo().version, /^\d+\.\d+\.\d+$/);
    delete process.env.BUILD_CHANNEL;
    resetBuildInfoCache();
  });

  test("version route shape: additive provenance fields only", async () => {
    const { getBuildInfo, resetBuildInfoCache } = await import("../src/server/version");
    process.env.APP_VERSION = "1.3.17";
    resetBuildInfoCache();
    const info = getBuildInfo();
    for (const key of ["version", "channel", "gitSha", "buildTime"]) assert.ok(key in info, key);
  });
});

describe("Fase 19/22: provenance release gates", () => {
  test("helper deploy precheck blocks label/tag mismatch", () => {
    const script = fs.readFileSync(path.join(ROOT, "scripts", "deploy-helper.sh"), "utf8");
    assert.match(script, /label version '.*' does not match requested/);
    assert.match(script, /fresh inventory healthy/);
  });

  test("dashboard deploy precheck blocks label/tag mismatch", () => {
    const script = fs.readFileSync(path.join(ROOT, "scripts", "update-dashboard.sh"), "utf8");
    assert.match(script, /Version-label precheck OK/);
  });

  test("published-artifact verification checks the OCI version label", () => {
    const script = fs.readFileSync(path.join(ROOT, "scripts", "verify-published.sh"), "utf8");
    assert.match(script, /org\.opencontainers\.image\.version/);
  });
});
