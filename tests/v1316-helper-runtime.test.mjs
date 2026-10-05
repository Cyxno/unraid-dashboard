/**
 * v1.3.16 release-gate: HELPER RUNTIME SMOKE + HANDLER INTEGRATION.
 *
 * Boots the REAL helper entrypoint as a subprocess against a mocked Docker
 * CLI (PATH injection, no socket, no host dependencies) and exercises the
 * actual /health and /inventory HTTP handlers end-to-end.
 *
 * Catches the failure class that shipped in v1.3.13: a helper that compiles
 * and passes pure unit tests but whose runtime wiring is broken (missing
 * import → /inventory hard-fails). Pure unit tests alone are not enough —
 * this suite runs the real process and demands FRESH inventory success.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FIXTURES = path.join(ROOT, "tests", "fixtures");
const MOCK_DOCKER = path.join(FIXTURES, "mock-docker");
const HELPER_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const SMOKE_TOKEN = "smoke-token-smoke-token-smoke-token";

function shortId(n) {
  return String(n).padStart(12, "0");
}
function fullId(n) {
  return `${shortId(n)}${"abcdef123456".repeat(5)}`.slice(0, 64);
}
function inspectLine(n, { labels = 1, digests = 1 } = {}) {
  return JSON.stringify({
    Id: fullId(n),
    Name: `/container-${n}`,
    Config: {
      Image: `registry.example/app${n}:tag`,
      Labels: Object.fromEntries([
        ["net.unraid.docker.managed", "dockerman"],
        ...Array.from({ length: labels }, (_, l) => [`com.example.k${l}`, "v".repeat(50)]),
      ]),
    },
    Image: `sha256:img${String(n).padStart(60, "0")}`,
    State: { Status: "running", Health: { Status: n % 2 === 0 ? "healthy" : undefined } },
    NetworkSettings: { Networks: { bridge: {} } },
    Mounts: [{ Type: "bind", Source: `/mnt/user/appdata/app${n}`, Destination: "/data" }],
    Created: "2026-10-04T00:00:00Z",
    RepoDigestsPlaceholder: digests,
  });
}

/** Write the fixture set a mock-docker run will serve. */
function writeFixtures(dir, containerCount) {
  const psLines = [];
  const inspectLines = [];
  const digestMap = {};
  for (let i = 1; i <= containerCount; i++) {
    psLines.push([shortId(i), `container-${i}`, `registry.example/app${i}:tag`, "running", "Up 1 hour"].join("\t"));
    inspectLines.push(inspectLine(i, { labels: i % 5 === 0 ? 25 : 3 }));
    const digest = `registry.example/app${i}@sha256:${String(i).padStart(64, "0")}`;
    digestMap[`registry.example/app${i}:tag`] = [digest];
    // the helper resolves RepoDigests via the container's image ID
    digestMap[`sha256:img${String(i).padStart(60, "0")}`] = [digest];
  }
  fs.writeFileSync(path.join(dir, "ps.txt"), psLines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "inspect.ndjson"), inspectLines.join("\n") + "\n");
  fs.writeFileSync(path.join(dir, "image-digests.json"), JSON.stringify(digestMap, null, 1));
  fs.writeFileSync(path.join(dir, "mode"), "ok\n");
}

/** Boot the REAL helper entrypoint on an ephemeral port with mocked Docker. */
async function bootHelper({ serverPath = path.join(ROOT, "helper", "server.js"), fixtureDir, _version = HELPER_VERSION }) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-helper-smoke-"));
  const mockBin = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-mock-bin-"));
  fs.symlinkSync(path.join(MOCK_DOCKER, "docker"), path.join(mockBin, "docker"));
  const env = {
    ...process.env,
    PATH: `${mockBin}:${process.env.PATH}`,
    MOCK_DOCKER_DIR: fixtureDir,
    HELPER_PORT: String(19000 + Math.floor(Math.random() * 4000)),
    HELPER_BIND: "127.0.0.1",
    STATE_DIR: stateDir,
    HOME: stateDir,
    UPDATE_HELPER_TOKEN: SMOKE_TOKEN,
  };
  const child = spawn(process.execPath, [serverPath], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  child.stdout.on("data", (c) => logs.push(c.toString()));
  child.stderr.on("data", (c) => logs.push(c.toString()));
  const base = `http://127.0.0.1:${env.HELPER_PORT}`;
  const deadline = Date.now() + 15_000;
  let up = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
      if (res.ok) { up = true; break; }
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    child, base, logs, env, stateDir,
    ready: up,
    async stop() {
      child.kill("SIGKILL");
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

async function getJson(base, pathname, token = SMOKE_TOKEN) {
  const res = await fetch(`${base}${pathname}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

test("Fase 1/3/6: real entrypoint boots, /health distinguishes process vs pipeline, fresh /inventory is healthy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-fixture-"));
  writeFixtures(dir, 3);
  const h = await bootHelper({ fixtureDir: dir });
  try {
    assert.equal(h.ready, true, "helper did not come up in time");
    const health1 = await getJson(h.base, "/health");
    assert.equal(health1.body.ok, true);
    assert.equal(health1.body.version, HELPER_VERSION);
    assert.ok(["unknown", "healthy", "partial"].includes(health1.body.inventoryStatus));
    const inv = await getJson(h.base, "/inventory");
    assert.equal(inv.status, 200, "fresh inventory must succeed — v1.3.13-class wiring bugs are release blockers");
    assert.equal(inv.body.containers.length, 3);
    const first = inv.body.containers[0];
    assert.equal(first.idShort.length, 12);
    assert.equal(first.idFull.length, 64);
    assert.ok(first.imageId.startsWith("sha256:"));
    assert.equal(first.repoDigests.length, 1);
    assert.ok(Object.keys(first.labels).length > 0);
    assert.equal(inv.body.diagnostics.structurallyDegraded, false);
    assert.equal(inv.body.diagnostics.parseErrors, 0);
    assert.equal(inv.body.version, HELPER_VERSION);
    const health2 = await getJson(h.base, "/health");
    assert.equal(health2.body.inventoryStatus, "healthy", "fresh refresh success MUST be healthy — stale cache must not fake green");
    const fatal = h.logs.join("").match(/Cannot find module|ReferenceError|uncaughtException|unhandledRejection/);
    assert.equal(fatal, null, `fatal startup log detected: ${fatal?.[0]}`);
  } finally {
    await h.stop();
  }
});

test("Fase 4: 100-container multi-chunk fixture through the real handler", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-fixture-"));
  writeFixtures(dir, 100);
  const h = await bootHelper({ fixtureDir: dir });
  try {
    assert.equal(h.ready, true);
    const inv = await getJson(h.base, "/inventory");
    assert.equal(inv.status, 200);
    assert.equal(inv.body.containers.length, 100);
    assert.equal(inv.body.diagnostics.totalContainers, 100);
    assert.equal(inv.body.diagnostics.chunks, Math.ceil(100 / 25));
    assert.equal(inv.body.diagnostics.imageIdCoverage, 100);
    assert.equal(inv.body.diagnostics.structurallyDegraded, false);
  } finally {
    await h.stop();
  }
});

test("Fase 5/6: failed refresh keeps last-known-good, /health degrades, no fake green", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-fixture-"));
  writeFixtures(dir, 2);
  const h = await bootHelper({ fixtureDir: dir });
  try {
    assert.equal(h.ready, true);
    const first = await getJson(h.base, "/inventory");
    assert.equal(first.status, 200);
    fs.writeFileSync(path.join(dir, "mode"), "fail\n");
    // Expire the inventory cache so the next request performs a REAL failed
    // refresh (a cache-hit would serve the previous healthy state).
    await new Promise((r) => setTimeout(r, 11_000));
    const second = await getJson(h.base, "/inventory");
    // last-known-good is served (200) but the degraded state is exposed
    assert.equal(second.status, 200);
    assert.equal(second.body.containers.length, 2);
    const health = await getJson(h.base, "/health");
    assert.equal(health.body.ok, true, "process is alive");
    assert.notEqual(health.body.inventoryStatus, "healthy", "pipeline degraded must be visible");
    assert.ok((health.body.lastRefreshFailures ?? 0) > 0);
  } finally {
    await h.stop();
  }
});

test("Fase 5: fresh boot with failing docker never fakes green (no cache to fall back on)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-fixture-"));
  writeFixtures(dir, 2);
  fs.writeFileSync(path.join(dir, "mode"), "fail\n");
  const h = await bootHelper({ fixtureDir: dir });
  try {
    assert.equal(h.ready, true, "process boots");
    const inv = await getJson(h.base, "/inventory");
    assert.notEqual(inv.status, 200, "no last-known-good and no docker: must NOT 200 with fabricated data");
    const health = await getJson(h.base, "/health");
    assert.notEqual(health.body.inventoryStatus, "healthy");
  } finally {
    await h.stop();
  }
});

test("Fase 1: the v1.3.13 incident (missing inventory import) is CAUGHT — broken entrypoint fails the gate", async () => {
  // Regenerate the broken fixture from the current entrypoint, then boot it:
  // /inventory must hard-fail exactly like production did.
  execFileSync(process.execPath, [path.join(ROOT, "scripts", "generate-test-fixtures.mjs")], { cwd: ROOT });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-fixture-"));
  writeFixtures(dir, 2);
  const h = await bootHelper({ serverPath: path.join(FIXTURES, "helper-broken", "server.js"), fixtureDir: dir });
  try {
    assert.equal(h.ready, true, "the broken helper boots fine — that is the point");
    const inv = await getJson(h.base, "/inventory");
    assert.equal(inv.status, 500, "missing wiring must hard-fail /inventory");
    // The release gate (smoke) requires fresh inventory 200 → this helper is rejected.
  } finally {
    await h.stop();
  }
});
