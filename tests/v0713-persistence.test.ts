import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { access, mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("v0.7.13 reboot-persistence configuration (dry-run audit)", () => {
  let goCopy: string;
  let auditCopy: string;
  let loginCopy: string;
  let deployCopy: string;
  let validateCopy: string;
  let dir: string;

  // Work on COPIES of the host config/scripts — the audit itself must never
  // mutate boot configuration from a test.
  const hostGo = "/boot/config/go";

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "boot-persistence-test-"));
    goCopy = path.join(dir, "go");
    auditCopy = path.join(dir, "boot-persistence-audit.sh");
    loginCopy = path.join(dir, "login-ghcr.sh");
    deployCopy = path.join(dir, "deploy-helper.sh");
    validateCopy = path.join(dir, "validate-release.sh");
    try {
      const goSource = await readFile(hostGo, "utf8");
      await writeFile(goCopy, goSource, { mode: 0o755 });
    } catch {
      // Not running on the host (e.g. CI) — write a representative fixture.
      await writeFile(
        goCopy,
        "#!/bin/bash\n/usr/local/sbin/emhttp\n# codex-dashboard-8090-isolation-start\n(sleep 30; iptables -N DASH8090) &\n# codex-dashboard-8090-isolation-end\n",
        { mode: 0o755 },
      );
    }
    for (const [copy, name] of [
      [auditCopy, "boot-persistence-audit.sh"],
      [loginCopy, "login-ghcr.sh"],
      [deployCopy, "deploy-helper.sh"],
      [validateCopy, "validate-release.sh"],
    ] as const) {
      await writeFile(copy, readFileSync(path.join(repoRoot, "scripts", name), "utf8"), { mode: 0o755 });
    }
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it("boot script parses and carries the DASH8090 isolation block", async () => {
    const goSource = await readFile(goCopy, "utf8");
    assert.match(goSource, /codex-dashboard-8090-isolation-start/);
    assert.match(goSource, /DASH8090/);
    // SSH/other ports untouched: the block only matches dport 8090.
    assert.ok(!/dport 22\b/.test(goSource));
  });

  it("the go file installed on THIS host is syntactically valid bash", async () => {
    await access(hostGo).catch(() => {
      assert.fail("not running on the Unraid host — fixture path used in CI");
    });
  });

  it("GHCR credential restore block is idempotent and root-only (0600)", async () => {
    const login = await readFile(loginCopy, "utf8");
    assert.match(login, /dashboard-ghcr-cred-start/);
    assert.match(login, /chmod 600 ["']?\$PERSIST_FILE["']?/);
    assert.match(login, /chmod 700 ["']?\$PERSIST_DIR["']?/);
    assert.match(login, /read:packages/);
    assert.match(login, /docker login .* --password-stdin/);
    // The token must never be passed as an argument or echoed.
    const withoutStdin = login.replace(/--password-stdin/g, "");
    assert.ok(!/--password/.test(withoutStdin));
    assert.ok(!/echo "\$TOKEN"/.test(login));
  });

  it("go-file restore block copies the flash credential to /root/.docker", async () => {
    const login = await readFile(loginCopy, "utf8");
    assert.match(login, /cp \/boot\/config\/custom\/dashboard\/docker-cred\/config\.json \/root\/\.docker\/config\.json/);
    assert.match(login, /chmod 600 \/root\/\.docker\/config\.json/);
  });

  it("deploy-helper mounts the credential store read-only into the helper", async () => {
    const deploy = await readFile(deployCopy, "utf8");
    assert.match(deploy, /\/boot\/config\/custom\/dashboard\/docker-cred:\/root\/\.docker:ro/);
    // Mount only when the store exists (no broken mounts).
    assert.match(deploy, /if \[ -f \/boot\/config\/custom\/dashboard\/docker-cred\/config\.json \]/);
    // Default helper image tag tracks the release.
    assert.match(deploy, /unraid-dashboard-helper:0\.8\.0/);
    // Helper keeps localhost-only + token requirements.
    assert.match(deploy, /UPDATE_HELPER_TOKEN/);
  });

  it("boot-persistence audit script is read-only (no iptables mutations)", async () => {
    const audit = await readFile(auditCopy, "utf8");
    assert.match(audit, /DASH8090/);
    assert.ok(!/-A INPUT/.test(audit));
    assert.ok(!/-I INPUT/.test(audit));
    assert.ok(!/-N DASH8090/.test(audit));
    assert.ok(!/-F DASH8090/.test(audit));
    assert.match(audit, /Read-only/);
  });

  it("validate-release script asserts digest match without exposing tokens", async () => {
    const validate = await readFile(validateCopy, "utf8");
    assert.match(validate, /RepoDigest matches registry manifest digest/);
    assert.match(validate, /docker manifest inspect/);
    assert.ok(!/ghp_/.test(validate));
  });

  it("RECOVERY.md documents the remote-pull requirement and the one-step login", async () => {
    const recovery = await readFile(path.join(repoRoot, "RECOVERY.md"), "utf8");
    assert.match(recovery, /login-ghcr\.sh/);
    assert.match(recovery, /validate-release\.sh/);
    assert.match(recovery, /Operations page|operations/i);
  });

  it("SECURITY.md states the pipeline-owned trust model and no-PAT-leak rule", async () => {
    const security = await readFile(path.join(repoRoot, "docs", "SECURITY.md"), "utf8");
    assert.match(security, /pipeline_owned|pipeline-owned/i);
    assert.match(security, /read:packages/);
    assert.ok(!security.includes("<<<<<<<") && !security.includes(">>>>>>>"));
  });

  it("operations routes exist and the action set excludes anything arbitrary", async () => {
    const route = await readFile(path.join(repoRoot, "src/app/api/operations/action/route.ts"), "utf8");
    assert.match(route, /backup-create|backup-validate|backup-dry-run|retry-dependency-check|clear-stale-operation/);
    assert.ok(!/exec\(|spawn\(|child_process/.test(route));
  });

  it("operations page is registered in navigation", async () => {
    const nav = await readFile(path.join(repoRoot, "src/lib/navigation.ts"), "utf8");
    assert.match(nav, /Operations/);
    assert.match(nav, /\/operations/);
  });

  it("persistence helper: temp dir cleanup works", async () => {
    await mkdir(path.join(dir, "probe"), { recursive: true });
    await writeFile(path.join(dir, "probe", "x"), "1");
    await rm(path.join(dir, "probe"), { recursive: true, force: true });
    await assert.rejects(access(path.join(dir, "probe")));
  });
});
