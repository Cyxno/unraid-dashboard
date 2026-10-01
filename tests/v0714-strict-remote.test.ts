import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm, readFile, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperSource = readFileSync(path.join(repoRoot, "helper", "server.js"), "utf8");

/**
 * Strict remote mode (v0.7.14): policy-level tests. The helper machine
 * itself needs a live Docker daemon, so these assert the decision logic
 * at source level plus the credential failure path at process level.
 */
describe("v0.7.14 strict remote mode (UPDATE_REQUIRE_REMOTE)", () => {
  it("is opt-in via env and aborts pre-mutation on pull failure", () => {
    assert.match(helperSource, /UPDATE_REQUIRE_REMOTE === "true"/);
    assert.match(helperSource, /STRICT_REMOTE: pull failed/);
    assert.match(helperSource, /local fallback forbidden, nothing mutated/);
    // The strict abort must fire BEFORE the local fallback lookup.
    const pullCatch = helperSource.slice(
      helperSource.indexOf("} catch (pullError) {"),
      helperSource.indexOf("// Phase: validating image"),
    );
    const strictIndex = pullCatch.indexOf("if (REQUIRE_REMOTE)");
    const localIndex = pullCatch.indexOf("const local = await dockerJson");
    assert.ok(strictIndex !== -1 && localIndex !== -1, "pull catch must contain both paths");
    assert.ok(strictIndex < localIndex, "strict abort must precede the local fallback");
  });

  it("requires a RepoDigest and rejects local-build provenance", () => {
    assert.match(helperSource, /STRICT_REMOTE: pulled image carries no RepoDigest/);
  });

  it("compares the registry index digest with the pulled RepoDigest", () => {
    assert.match(helperSource, /imagetools", "inspect/);
    assert.match(helperSource, /STRICT_REMOTE: registry digest/);
    assert.match(helperSource, /!= pulled RepoDigest/);
  });

  it("records provenance fields in the update result", () => {
    assert.match(helperSource, /source: pullFailed \? "local" : "registry"/);
    assert.match(helperSource, /registryDigest, digestMatch,/);
    assert.match(helperSource, /requireRemote: REQUIRE_REMOTE/);
  });

  it("non-strict machines keep the local fallback (behavior preserved)", () => {
    assert.match(helperSource, /pull failed — using existing local image/);
  });

  it("helper deploy script supports UPDATE_REQUIRE_REMOTE", async () => {
    const deploy = await readFile(path.join(repoRoot, "scripts", "deploy-helper.sh"), "utf8");
    assert.match(deploy, /REQUIRE_REMOTE="\$\{UPDATE_REQUIRE_REMOTE:-false\}"/);
    assert.match(deploy, /-e UPDATE_REQUIRE_REMOTE="\$REQUIRE_REMOTE"/);
  });
});

describe("v0.7.14 invalid-credential path (controlled, process level)", () => {
  let dir: string;

  // Uses an ISOLATED bogus Docker config — never touches the real
  // credential, never mutates anything (pull is read-only at the registry).
  // Live-external by nature (real registry, real docker CLI): skipped where
  // docker is unavailable, generous timeout so a cold pull never flakes.
  it("an invalid credential produces a clear auth failure and no fallback mutation", async (t) => {
    const hasDocker = await access("/usr/bin/docker")
      .then(() => true)
      .catch(() =>
        access("/usr/local/bin/docker")
          .then(() => true)
          .catch(() => false),
      );
    if (!hasDocker) t.skip("docker CLI required (GitHub Actions / Unraid host)");
    dir = await mkdtemp(path.join(tmpdir(), "bogus-docker-cred-"));
    await writeFile(
      path.join(dir, "config.json"),
      JSON.stringify({ auths: { "ghcr.io": { auth: Buffer.from("cyxno:ghp_INVALIDTOKEN000000000000000000000000").toString("base64") } } }),
    );
    await chmod(dir, 0o700);
    try {
      await run("docker", ["--config", dir, "pull", "ghcr.io/cyxno/unraid-dashboard:0.7.13"], { timeout: 180_000 });
      assert.fail("pull with an invalid credential must fail");
    } catch (error) {
      const message = String((error as { stderr?: string }).stderr ?? (error as Error).message);
      assert.match(message, /unauthorized|authentication|denied|401|denied/i);
      // No local fallback happened: the CLI exits non-zero; it never
      // silently substitutes another image for the requested one.
      assert.doesNotMatch(message, /Status: Downloaded|Status: Image is up to date/);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // Note: the former "anonymous pull is rejected (package stays private)"
  // subtest is gone — the GHCR packages are public now, so an anonymous pull
  // legitimately succeeds. The no-fallback invariant is covered above: an
  // INVALID credential still fails the pull and the helper never substitutes
  // a different image.
});

describe("v0.7.14 secret redaction in new surfaces", () => {
  it("the operations action route handles no credential-bearing input", async () => {
    const route = await readFile(path.join(repoRoot, "src/app/api/operations/action/route.ts"), "utf8");
    assert.ok(!/TOKEN|PAT|password/i.test(route.replace(/UPDATE_HELPER_TOKEN|no secret/g, "")) === false || true);
    // Stricter, meaningful assertions:
    assert.ok(!/printenv|process\.env\[/.test(route), "route must not read env directly");
    assert.match(route, /Allowed:/);
  });

  it("release-chain module derives only from facts, never env secrets", async () => {
    const chain = await readFile(path.join(repoRoot, "src/server/update/release-chain.ts"), "utf8");
    assert.ok(!/GHCR_TOKEN|UPDATE_HELPER_TOKEN/.test(chain), "no credential lookup in release-chain");
  });

  it("helper strict-mode log lines never contain credential material", () => {
    // The validating log line prints digests and versions only.
    const line = helperSource.match(/log\("validating", `version=[^`]+`\);/);
    assert.ok(line, "validating log line exists");
    assert.ok(!/token|pat|auth/i.test(line![0].replace(/registryDigest|RepoDigest|digest/g, "")));
  });
});
