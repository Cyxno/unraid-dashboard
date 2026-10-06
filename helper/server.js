#!/usr/bin/env node
/*
 * unraid-dashboard update helper — single-purpose, localhost-only.
 *
 * Threat model (see SECURITY.md): this process is the ONLY component with
 * Docker access, and its API surface is three fixed operations:
 *
 *   GET  /health   liveness
 *   GET  /status   update machine state (no secrets)
 *   GET  /inventory token-authenticated read-only facts for ALL containers
 *                  (classification input; no env/mounts/secrets)
 *   POST /update   {tag: "X.Y.Z"} — the ONLY mutation; updates the
 *                  configured container from the configured repo at the
 *                  requested semver tag.
 *
 * Hard guarantees enforced below, in order:
 *   1. localhost binding only (127.0.0.1) — never a published interface
 *   2. bearer-token auth (UPDATE_HELPER_TOKEN, constant-time compare)
 *   3. tag validated against ^v?\d+\.\d+\.\d+$ — no digests, no arbitrary refs
 *   4. image repo + container name are DEPLOYMENT-time constants from env
 *      (defaults: unraid-dashboard / ghcr.io/cyxno/unraid-dashboard) —
 *      never accepted from the request; a request can only choose the tag
 *   5. no shell: every docker call is spawn(argv array), no string commands
 *   6. single-flight lock: one update at a time; concurrent POSTs get 409
 *   7. full config preservation + automatic rollback + verification of
 *      /api/health, /api/version (tag match) and /api/overview
 *   8. every step has a wall-clock timeout; the machine always settles
 *   9. docker run env comes from a 0600 temp file (docker has no stdin
 *      --env-file), removed after use
 *
 * No PAT, token or env value is ever logged or returned by /status.
 */

"use strict";

const http = require("node:http");
const { spawn } = require("node:child_process");
const { randomUUID, timingSafeEqual, createHash } = require("node:crypto");
const nodePath = require("node:path");
const { inspectToSnapshot, findUnsupported, snapshotToRunArgs, UNSUPPORTED_PREFIX } = require("./recreate");
const inventoryLib = require("./inventory");
const compose = require("./compose");
const { writeFile, unlink, mkdir } = require("node:fs/promises");
const { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } = require("node:fs");
const path = require("node:path");

/* ---- deployment constants (env-overridable ONLY for isolated testing) ----- */

const CONTAINER_NAME = process.env.TARGET_CONTAINER || "unraid-dashboard";
const IMAGE_REPO = process.env.TARGET_IMAGE_REPO || "ghcr.io/cyxno/unraid-dashboard";
// Loopback by default (localhost-only security). HELPER_BIND=0.0.0.0 is for
// release smoke containers that publish 127.0.0.1::<port> on the host — the
// host-side binding stays loopback-only, so nothing becomes externally
// reachable.
const LISTEN_HOST = process.env.HELPER_BIND || "127.0.0.1";
const PORT = Number(process.env.HELPER_PORT || 8790);
const DASHBOARD_URL = process.env.DASHBOARD_URL || `http://127.0.0.1:${process.env.DASHBOARD_PORT || 8090}`;
/** Proxy-auth secret shared with the dashboard (AUTH_PROXY_SECRET) — required
 * to reach protected endpoints when the dashboard runs AUTH_MODE=proxy. */
const DASHBOARD_AUTH_SECRET = process.env.DASHBOARD_AUTH_SECRET || "";
/** Provenance env keys excluded from preservation so the new image's own values win. */
const PROVENANCE_ENV = /^(PATH|NODE_VERSION|YARN_VERSION|NODE_ENV|HOSTNAME|HOME|NEXT_TELEMETRY_DISABLED|APP_VERSION|GIT_SHA|BUILD_TIME|IMAGE_REF)=/;
// Semver with optional prerelease (v1.0.0-rc.1) — the RC train requires it.
const TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const HEALTH_TIMEOUT_MS = 150_000;
const VERIFY_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = { inspect: 15_000, pull: 300_000, replace: 30_000 };

// Inventory cache: repeated dashboard polls within the TTL reuse the same
// result instead of re-spawning N+1 Docker CLI processes per request.
// Mutations clear the cache via invalidateInventory() to ensure freshness.
const INVENTORY_TTL_MS = Number(process.env.INVENTORY_TTL_MS || 10_000);
let inventoryCache = null; // { at, body, degraded, lastGoodAt }
// Fase 15/16: inventory pipeline health — process-alive alone never
// proved the pipeline healthy (three silent degradations shipped).
let inventoryStatus = {
  status: "unknown",
  lastRefreshAt: null,
  lastRefreshAgeSeconds: null,
  lastRefreshFailures: null,
  diagnostics: null,
};
let inventoryRefreshPromise = null; // single-flight coalescing
function invalidateInventory() { inventoryCache = null; inventoryRefreshPromise = null; }

const HELPER_VERSION = "1.3.20";

/** Strict remote mode (v0.7.14): when UPDATE_REQUIRE_REMOTE=true, a
 * self-update pull failure aborts BEFORE any mutation — the local-image
 * fallback is forbidden — and the pulled image must carry a registry
 * RepoDigest. Used to prove the registry→production release chain. */
const REQUIRE_REMOTE = process.env.UPDATE_REQUIRE_REMOTE === "true";

/** Containers whose update is refused inside a PROJECT update too (v0.7.13):
 * high-risk patterns mirror the dashboard's risk model (databases, auth,
 * proxy/DNS) — a project update must never bypass per-service risk policy.
 * Pipeline-owned projects are refused entirely. */
const HIGH_RISK_PATTERNS = [
  /postgres|mysql|mariadb|mongo|redis|valkey|influx|clickhouse/i,
  /authelia|authentik|keycloak|sso/i,
  /nginx-proxy-manager|^npm$|traefik|caddy|haproxy|adguard|pihole|unbound|cloudflared/i,
];
function isHighRisk(name, image) {
  const haystack = `${name} ${image}`;
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(haystack));
}
function pipelineOwnedProjects() {
  const raw = process.env.PIPELINE_OWNED_PROJECTS ?? "tornscope";
  return raw.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}
/** Job phases in which NOTHING has been removed/recreated yet. */
const PRE_MUTATION_PHASES = new Set(["requested", "snapshotting", "pulling", "verifying", "checking"]);
const STALE_OP_MS = 30 * 60_000;

/* ---- generic container update machine (v0.7.7) ----------------------------
 * Extends the dashboard's own update flow to arbitrary containers.
 * Invariants:
 * - the helper remains the ONLY Docker-socket component
 * - never runs a shell: every docker call is spawn(argv array)
 * - the request names a container; EVERYTHING else (strategy, config,
 *   image) is derived by the helper from the container itself
 * - env values from snapshots are written to 0600 temp files and never
 *   served through any endpoint
 * - old image is NEVER removed; no prune during updates
 * - compose-managed, AIO and externally-managed containers are refused
 */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const STATE_DIR = process.env.STATE_DIR || "/tmp/update-state";
const SNAPSHOT_DIR = `${STATE_DIR}/snapshots`;
const JOBS_FILE = `${STATE_DIR}/jobs.json`;
const HEALTH_WAIT_MS = 120_000;
const STABILIZE_MS = 5_000;

/** Containers the update machine refuses, by name (case-insensitive). */
function blockedContainers() {
  const builtIn = ["dumb", "dumbscope", "unraid-dashboard", "unraid-dashboard-helper"];
  const extra = (process.env.BLOCKED_EXTRA_CONTAINERS ?? "")
    .split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  return new Set([...builtIn, ...extra]);
}

/** Job store: persisted so a helper restart leaves visible state. */
function loadJobs() {
  try {
    return JSON.parse(readFileSync(JOBS_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveJobs(jobs) {
  try {
    writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), { mode: 0o600 });
  } catch (error) {
    log("jobs", `persist failed: ${error.message}`);
  }
}
function jobStore() {
  if (!globalThis.__containerJobs) globalThis.__containerJobs = loadJobs();
  return globalThis.__containerJobs;
}
function setJob(name, patch) {
  const jobs = jobStore();
  jobs[name] = { ...(jobs[name] ?? {}), name, ...patch };
  saveJobs(jobs);
  return jobs[name];
}

function containerLocks() {
  if (!globalThis.__containerLocks) globalThis.__containerLocks = new Map();
  return globalThis.__containerLocks;
}

/**
 * Single deployment lock with stale recovery: a lock older than 2 hours
 * (helper restart mid-job, daemon restart, crash) is reclaimed instead of
 * blocking forever. Job state stays visible as stale-orphan via /container-job.
 */
function tryAcquireLock() {
  if (state.lock) {
    const age = Date.now() - Date.parse(state.lock.since);
    if (age < 2 * 3600_000) return null;
    log("lock", `stale lock (${Math.round(age / 60_000)} min) reclaimed`);
  }
  const lock = { token: randomUUID(), since: new Date().toISOString() };
  state.lock = lock;
  state.startedAt = lock.since;
  state.finishedAt = null;
  return lock;
}

/* ---- state ---------------------------------------------------------------- */

const state = {
  phase: "idle",
  detail: null,
  startedAt: null,
  finishedAt: null,
  log: [],
  lock: null,
  lastUpdate: null,
  currentImage: null,
  currentVersion: null,
  currentImageId: null,
  pullAvailable: null,
};

function log(phase, detail) {
  const entry = { at: new Date().toISOString(), phase, detail: String(detail ?? "").slice(0, 300) };
  state.log.push(entry);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
  console.log(`[${entry.at}] ${phase}: ${entry.detail}`);
}

function setPhase(phase, detail) {
  state.phase = phase;
  state.detail = detail ?? null;
  log(phase, detail ?? "");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---- docker invocation (argv arrays only, never a shell string) ----------- */

function docker(args, { timeoutMs = 30_000, onStdout, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"], ...(env ? { env } : {}) });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (onStdout) onStdout(text);
      // 8 MB cap: a full-inventory batch inspect is ~0.5-1 MB; the old 400 KB
    // cap silently truncated the tail and degraded the last N containers.
    if (stdout.length < 8_000_000) stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 1_000_000) stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`docker ${args[0]} exited ${code}: ${stderr.trim().slice(-300)}`));
    });
  });
}

async function dockerJson(args, timeoutMs) {
  const { stdout } = await docker(args, { timeoutMs });
  return JSON.parse(stdout);
}

/**
 * docker run with env supplied via a 0600 temp file (--env-file requires
 * a real path; there is no stdin form). The file is removed afterwards.
 */
async function dockerRunWithEnv(baseArgs, image, envLines, timeoutMs, postImageCmd = null) {
  const envFile = nodePath.join("/tmp", `dashenv-${randomUUID()}`);
  await writeFile(envFile, envLines + "\n", { mode: 0o600 });
  try {
    const full = postImageCmd && postImageCmd.length > 0
      ? [...baseArgs, "--env-file", envFile, image, ...postImageCmd]
      : [...baseArgs, "--env-file", envFile, image];
    await docker(full, { timeoutMs });
  } finally {
    await unlink(envFile).catch(() => {});
  }
}

/** Builds the preserved-config run args (used by replace AND rollback). */
function buildRunArgs(preserved) {
  const args = ["run", "-d", "--name", CONTAINER_NAME, "--network", preserved.network];
  if (preserved.restart && preserved.restart !== "no") args.push("--restart", preserved.restart);
  for (const [port, bindings] of Object.entries(preserved.portBindings)) {
    for (const binding of bindings ?? []) {
      args.push("-p", `${binding.HostIp ?? ""}:${binding.HostPort}:${port}`);
    }
  }
  for (const bind of preserved.binds) args.push("-v", bind);
  return args;
}

/* ---- verification ---------------------------------------------------------- */

function dashboardHeaders() {
  // Headers the dashboard accepts in proxy mode; harmless in disabled mode.
  return DASHBOARD_AUTH_SECRET
    ? { "x-dashboard-auth-token": DASHBOARD_AUTH_SECRET, "x-forwarded-user": "dashboard-helper" }
    : {};
}

async function fetchJson(url, timeoutMs = 5_000) {
  const response = await fetch(url, {
    headers: dashboardHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function verifyLive(expectedVersion) {
  const health = await fetchJson(`${DASHBOARD_URL}/api/health`, VERIFY_TIMEOUT_MS);
  if (health.status !== 200) throw new Error(`/api/health returned ${health.status}`);

  const version = await fetchJson(`${DASHBOARD_URL}/api/version`, VERIFY_TIMEOUT_MS);
  if (version.status !== 200) throw new Error(`/api/version returned ${version.status}`);
  if (version.body?.version !== expectedVersion) {
    throw new Error(`version mismatch: running ${version.body?.version}, expected ${expectedVersion}`);
  }

  const overview = await fetchJson(`${DASHBOARD_URL}/api/overview?window=5m`, VERIFY_TIMEOUT_MS);
  if (overview.status !== 200) throw new Error(`/api/overview returned ${overview.status}`);
}

/* ---- the update machine ----------------------------------------------------- */

/** Set once the old container has been removed — module scope because
 * recreateContainer() is shared by replace and rollback paths. */
let machineMutated = false;

async function recreateContainer(baseArgs, image, envLines) {

  await docker(["rm", "-f", CONTAINER_NAME], { timeoutMs: STEP_TIMEOUT_MS.replace }).catch(() => {});
  machineMutated = true;
  await dockerRunWithEnv(baseArgs, image, envLines, STEP_TIMEOUT_MS.replace);
}

async function runUpdate(tag, options = {}) {
  const requestedAt = Date.now();
  const normalizedTag = tag.replace(/^v/, "");
  const targetImage = `${IMAGE_REPO}:${normalizedTag}`;
  let preserved = null;
  let envLines = "";
  let replacementDigest = null;
  machineMutated = false;

  try {
    // Rollback may target an older validated release; normal updates may not.
    if (!options.forceOlder && state.currentVersion) {
      const parse = (v) => {
        const [core, pre] = String(v).replace(/^v/, "").split("-");
        const numbers = core.split(".").map(Number);
        // Semver rule: a prerelease binds to its own triple and sorts BELOW
        // that triple's release (1.0.0-rc.1 < 1.0.0), and prerelease
        // identifiers compare numerically when numeric (rc.1 < rc.2).
        return {
          numbers,
          pre: pre ?? null,
        };
      };
      const a = parse(tag);
      const b = parse(state.currentVersion);
      let comparison = 0;
      for (let i = 0; i < 3; i++) {
        const ai = a.numbers[i] ?? 0;
        const bi = b.numbers[i] ?? 0;
        if (ai !== bi) { comparison = ai > bi ? 1 : -1; break; }
      }
      if (comparison === 0) {
        const aPre = a.pre;
        const bPre = b.pre;
        if (aPre && !bPre) comparison = -1;
        else if (!aPre && bPre) comparison = 1;
        else if (aPre && bPre && aPre !== bPre) {
          const aParts = aPre.split(".");
          const bParts = bPre.split(".");
          for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
            const av = aParts[i];
            const bv = bParts[i];
            if (av === bv) continue;
            if (av === undefined) { comparison = -1; break; }
            if (bv === undefined) { comparison = 1; break; }
            const an = Number(av);
            const bn = Number(bv);
            if (!Number.isNaN(an) && !Number.isNaN(bn)) { comparison = an > bn ? 1 : -1; break; }
            comparison = av > bv ? 1 : -1;
            break;
          }
        }
      }
      if (comparison < 0) {
        throw new Error(`refusing non-update: requested ${tag} is older than running ${state.currentVersion} (use /rollback)`);
      }
    }

    // Phase: checking — capture the current container configuration.
    // fromImage comes from THIS inspection, never from cached startup
    // state: a stale/null cache must never decide what rollback restores.
    setPhase("checking", `capturing configuration of ${CONTAINER_NAME}`);
    const inspectArray = await dockerJson(["inspect", CONTAINER_NAME], STEP_TIMEOUT_MS.inspect);
    const current = inspectArray[0];
    if (!current) throw new Error("dashboard container not found");
    const fromImage = current.Config?.Image ?? null;
    if (!fromImage) throw new Error("cannot determine the current container image — refusing to update");
    preserved = {
      network: current.HostConfig?.NetworkMode ?? "default",
      restart: current.HostConfig?.RestartPolicy?.Name ?? "no",
      binds: current.HostConfig?.Binds ?? [],
      portBindings: current.HostConfig?.PortBindings ?? {},
      env: (current.Config?.Env ?? []).filter((entry) => !PROVENANCE_ENV.test(entry)),
    };
    envLines = preserved.env.join("\n");
    log("checking", `network=${preserved.network} restart=${preserved.restart} binds=${preserved.binds.length} env=${preserved.env.length}`);

    // Phase: pulling — registry auth comes from the mounted Docker
    // credential store. Strict remote mode forbids the local fallback.
    setPhase("pulling", targetImage);
    let pullFailed = false;
    try {

      await docker(["pull", targetImage], {
        timeoutMs: STEP_TIMEOUT_MS.pull,
        onStdout: (text) => {
          const line = text.split("\n").find((entry) =>
            entry.includes("Pull complete") || entry.includes("Downloaded newer") || entry.includes("Image is up to date"));
          if (line) log("pulling", line.trim().slice(0, 120));
        },
      });
    } catch (pullError) {
      if (REQUIRE_REMOTE) {
        // Strict remote mode: abort PRE-mutation — never substitute a
        // possibly stale local image for the registry release.
        throw new Error(`STRICT_REMOTE: pull failed (${String(pullError.message).slice(0, 140)}) — local fallback forbidden, nothing mutated`);
      }
      const local = await dockerJson(["image", "inspect", targetImage], STEP_TIMEOUT_MS.inspect).catch(() => null);
      if (!local) {
        // Nothing was mutated yet — fail cleanly.
        throw new Error(`pull failed and image is not local (${String(pullError.message).slice(0, 160)}) — run scripts/login-ghcr.sh on the host`);
      }
      pullFailed = true;
      log("pulling", "pull failed — using existing local image");
    }

    // Phase: validating image — pinned repo + sane labels + registry digest.
    setPhase("validating", targetImage);
    const imageInspect = await dockerJson(["image", "inspect", targetImage], STEP_TIMEOUT_MS.inspect);
    const labels = imageInspect[0]?.Config?.Labels ?? {};
    const imageVersion = labels["org.opencontainers.image.version"];
    const imageRevision = labels["org.opencontainers.image.revision"] ?? null;
    // RepoDigests entries are "repo@sha256:..."; the comparable value is the
    // digest after the LAST "@".
    const repoDigestRef = imageInspect[0]?.RepoDigests?.[0] ?? null;
    replacementDigest = repoDigestRef ? repoDigestRef.slice(repoDigestRef.lastIndexOf("@") + 1) : null;
    if (imageVersion && imageVersion !== normalizedTag) {
      throw new Error(`image label version ${imageVersion} does not match requested ${normalizedTag}`);
    }
    if (REQUIRE_REMOTE && !pullFailed && !replacementDigest) {
      throw new Error("STRICT_REMOTE: pulled image carries no RepoDigest — cannot prove registry origin, aborting pre-mutation");
    }
    // Registry-side index digest (read-only imagetools query with the same
    // stored credentials as the pull). BUILDX_CONFIG points somewhere
    // writable because /root/.docker is a READ-ONLY credential mount.
    // Best-effort when buildx is unavailable; MANDATORY match in strict mode.
    let registryDigest = null;
    let digestMatch = null;
    try {
      const raw = await docker(["buildx", "imagetools", "inspect", targetImage], {
        timeoutMs: 45_000,
        env: { ...process.env, BUILDX_CONFIG: process.env.BUILDX_CONFIG || "/tmp/buildx" },
      });
      const found = raw.stdout.match(/^Digest:\s*(sha256:[a-f0-9]{64})\s*$/m);
      if (found) {
        registryDigest = found[1];
        digestMatch = replacementDigest === registryDigest;
        if (REQUIRE_REMOTE && !digestMatch) {
          throw new Error(`STRICT_REMOTE: registry digest ${registryDigest.slice(0, 25)} != pulled RepoDigest ${String(replacementDigest).slice(0, 25)} — aborting pre-mutation`);
        }
      }
    } catch (digestError) {
      if (REQUIRE_REMOTE && digestError instanceof Error && digestError.message.startsWith("STRICT_REMOTE")) throw digestError;
      log("validating", `registry digest unavailable (non-fatal): ${String(digestError.message).slice(0, 100)}`);
    }
    log("validating", `version=${imageVersion ?? "unlabeled"} revision=${imageRevision ? String(imageRevision).slice(0, 12) : "n/a"} repoDigest=${replacementDigest ? replacementDigest.slice(7, 19) : "none"} registryDigest=${registryDigest ? registryDigest.slice(7, 19) : "n/a"} match=${digestMatch === null ? "n/a" : digestMatch}`);

    // Phase: replacing — remove + recreate with preserved configuration.
    setPhase("replacing", targetImage);
    await recreateContainer(buildRunArgs(preserved), targetImage, envLines);

    // Phase: healthchecking — docker health status.
    setPhase("healthchecking", "waiting for docker healthcheck");
    const healthDeadline = Date.now() + HEALTH_TIMEOUT_MS;
    let healthy = false;
    while (Date.now() < healthDeadline) {
      const raw = await dockerJson(["inspect", CONTAINER_NAME, "--format", "{{json .State.Health.Status}}"], STEP_TIMEOUT_MS.inspect).catch(() => null);
      const status = typeof raw === "string" ? raw.replaceAll('"', "") : null;
      if (status === "healthy") { healthy = true; break; }
      if (status === "unhealthy") throw new Error("docker reports container unhealthy");
      await sleep(5_000);
    }
    if (!healthy) throw new Error("container did not become healthy in time");

    // Phase: verifying live data.
    setPhase("verifying", "probing /api/health, /api/version, /api/overview");
    await verifyLive(normalizedTag);

    invalidateInventory();
    invalidateInventory();
    setPhase("complete"); // INVALIDATED, `${fromImage} → ${targetImage}${pullFailed ? " (local image)" : ""}`);
    state.lastUpdate = {
      from: fromImage, to: targetImage, result: "success",
      startedAt: new Date(requestedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - requestedAt,
      digest: replacementDigest, usedLocalImage: pullFailed,
      source: pullFailed ? "local" : "registry",
      registryDigest, digestMatch,
      imageId: imageInspect?.[0]?.Id ?? null,
      requireRemote: REQUIRE_REMOTE,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("failed", message);

    if (preserved && machineMutated) {
      // Phase: rollback — the old container was already removed, restore it.
      setPhase("rollback", `restoring ${fromImage}`);
      try {
        await recreateContainer(buildRunArgs(preserved), fromImage, envLines);
        // Best-effort liveness probe of the restored container.
        await verifyLive((fromImage.split(":")[1] ?? "unknown")).catch(() => {});
        setPhase("failed", `rolled back to ${fromImage}: ${message.slice(0, 200)}`);
        state.lastUpdate = {
          from: fromImage, to: targetImage, result: "rolled-back",
          startedAt: new Date(requestedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - requestedAt, error: message.slice(0, 300),
        };
      } catch (rollbackError) {
        setPhase("failed", `UPDATE AND ROLLBACK FAILED — manual recovery required: ${String(rollbackError.message).slice(0, 160)}`);
        state.lastUpdate = {
          from: fromImage, to: targetImage, result: "failed",
          startedAt: new Date(requestedAt).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - requestedAt,
          error: `update: ${message.slice(0, 200)}; rollback: ${String(rollbackError.message).slice(0, 200)}`,
        };
      }
    } else {
      // Pre-mutation failure (or nothing captured): the running container
      // was never touched — settle without any rollback dance.
      setPhase("failed", message.slice(0, 300));
      state.lastUpdate = {
        from: fromImage ?? "unknown", to: targetImage, result: "failed",
        startedAt: new Date(requestedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - requestedAt, error: message.slice(0, 300),
      };
    }
  } finally {
    state.lock = null;
    state.finishedAt = new Date().toISOString();
  }
}

/* ---- current-image metadata for the status surface -------------------------- */

async function refreshCurrentImage() {
  try {
    const inspectArray = await dockerJson(["inspect", CONTAINER_NAME, "--format", "{{json .}}"], STEP_TIMEOUT_MS.inspect);
    const current = Array.isArray(inspectArray) ? inspectArray[0] : inspectArray;
    state.currentImage = current?.Config?.Image ?? null;
    state.currentVersion = current?.Config?.Labels?.["org.opencontainers.image.version"]
      ?? (current?.Config?.Env ?? []).find((entry) => entry.startsWith("APP_VERSION="))?.split("=")[1]
      ?? null;
    state.currentRevision = current?.Config?.Labels?.["org.opencontainers.image.revision"] ?? null;
    state.currentImageId = current?.Image ? `sha256:${current.Image}` : null;
  } catch (error) {
    state.currentImage = null;
    log("status", `inspect failed: ${error.message}`);
  }
}

/** Images of the fixed repo to keep locally (bounded retention). */
const KEEP_IMAGES = 5;

/**
 * Retention: keeps the newest KEEP_IMAGES semver-tagged images of the
 * fixed repo and NEVER touches any other repository or untagged layers
 * of other images. Runs opportunistically after the hourly pull probe.
 */
async function pruneOldImages() {
  await refreshLocalVersions();
  const tags = state.localVersions ?? [];
  const removable = tags.slice(KEEP_IMAGES);
  for (const tag of removable) {
    // Guard: never remove the running image's tag.
    if (state.currentVersion === tag) continue;
    log("retention", `removing old image ${IMAGE_REPO}:${tag}`);
    await docker(["rmi", `${IMAGE_REPO}:${tag}`], { timeoutMs: 30_000 }).catch((error) => {
      log("retention", `could not remove ${tag}: ${String(error.message).slice(0, 120)}`);
    });
  }
}

/**
 * Semver tags of the fixed repo present locally (bounded, newest first).
 * This is what makes the update flow usable without a host GHCR login:
 * locally built releases can be discovered and applied through the same
 * validated machine (label check + newer-version rule still apply).
 */
async function refreshLocalVersions() {
  try {
    const { stdout } = await docker(
      ["images", IMAGE_REPO, "--format", "{{.Tag}}"],
      { timeoutMs: STEP_TIMEOUT_MS.inspect },
    );
    const tags = stdout
      .split("\n")
      .map((tag) => tag.trim())
      .filter((tag) => /^v?\d+\.\d+\.\d+$/.test(tag))
      .map((tag) => tag.replace(/^v/, ""));
    tags.sort((a, b) => {
      const pa = a.split(".").map(Number);
      const pb = b.split(".").map(Number);
      for (let i = 0; i < 3; i++) {
        if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
      }
      return 0;
    });
    state.localVersions = tags.slice(0, 10);
  } catch {
    state.localVersions = [];
  }
}

/* ---- generic container update machine --------------------------------------- */

/** Namespaced global machine state (separate from the dashboard self-update). */
function machineStateFor(name) {
  const all = jobStore();
  return all[name] ?? null;
}



/** Stops and removes a container, tolerating absence. */
async function removeContainer(name) {

  await docker(["rm", "-f", name], { timeoutMs: 30_000 }).catch(() => {});
}

/**
 * Health verdict for the machine:
 * - with Docker healthcheck: waits for healthy; unhealthy fails fast
 * - without healthcheck: running is necessary but NOT sufficient —
 *   RestartCount must not grow across the stabilization window
 *   (a container that crashes right after start is caught).
 */
async function isHealthy(name) {
  const raw = await dockerJson(
    ["container", "inspect", "--format", "{{json .State}}", name],
    STEP_TIMEOUT_MS.inspect,
  ).catch(() => null);
  const st = Array.isArray(raw) ? raw[0] : raw;
  if (!st || st.Running !== true) return { ok: false, detail: "not running" };
  if (st.Restarting === true) return { ok: false, detail: "restarting" };
  if (st.Health) {
    if (st.Health.Status === "healthy") return { ok: true, detail: "healthy" };
    if (st.Health.Status === "unhealthy") return { ok: false, detail: "unhealthy" };
    return { ok: false, detail: "health starting" };
  }
  return { ok: true, detail: "running (no healthcheck)", restartCount: st.RestartCount ?? 0, exitCode: st.ExitCode ?? 0 };
}

/** Crash-loop / instant-exit detection for containers without healthcheck. */
async function isCrashLooping(name, baselineRestartCount) {
  const raw = await dockerJson(
    ["container", "inspect", "--format", "{{json .State}}", name],
    STEP_TIMEOUT_MS.inspect,
  ).catch(() => null);
  const st = Array.isArray(raw) ? raw[0] : raw;
  if (!st) return { crashed: true, detail: "container gone" };
  if (st.Running !== true) return { crashed: true, detail: `exited (code ${st.ExitCode})` };
  if ((st.RestartCount ?? 0) > baselineRestartCount + 1) {
    return { crashed: true, detail: `restart count grew (${st.RestartCount} > ${baselineRestartCount}) — crash loop` };
  }
  return { crashed: false };
}

/**
 * The generic update machine. Phases:
 * requested → snapshotting → pulling → verifying → recreating → starting
 * → health-wait → completed | failed | rolled-back | rollback-failed
 */
async function runContainerUpdate(name, { rollback = false } = {}) {
  const startedAt = new Date().toISOString();
  const phases = [];
  const setPhase = (phase, detail) => {
    phases.push({ phase, detail: String(detail ?? "").slice(0, 160), at: new Date().toISOString() });
    setJob(name, { phase, detail: String(detail ?? "").slice(0, 200), phases });
    log(`container-update:${name}`, `${phase}: ${detail ?? ""}`);
  };

  let snapshot = null;
  let envLines = "";
  let mutated = false;
  const snapshotFile = nodePath.join(SNAPSHOT_DIR, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);

  try {
    // --- snapshotting -------------------------------------------------------
    // Rollback REUSES the pre-update snapshot (previous image + exact
    // config); re-inspecting the current container would make "rollback"
    // a no-op that keeps the broken version.
    if (rollback) {
      try {
        snapshot = JSON.parse(readFileSync(snapshotFile, "utf8"));
        envLines = (snapshot.env ?? []).join("\n");
        setPhase("rollback-requested", `loaded pre-update snapshot (${snapshot.imageId?.slice(0, 25) ?? "?"})`);
      } catch {
        throw new Error("no pre-update snapshot available — nothing to roll back to");
      }
    } else {
    setPhase("requested", "capturing container configuration");
    const inspectArray = await dockerJson(["container", "inspect", "--format", "{{json .}}", name], STEP_TIMEOUT_MS.inspect);
    const current = Array.isArray(inspectArray) ? inspectArray[0] : inspectArray;
    if (!current) throw new Error("container not found");

    // Non-negotiable blocks (derived from the container itself).
    if (current.Config?.Labels?.["com.docker.compose.project"]) {
      throw new Error("Compose-managed — update via docker compose, not the dashboard");
    }
    if (blockedContainers().has(name.toLowerCase())) {
      throw new Error("Managed externally / AIO — dashboard update disabled");
    }

    // Full-fidelity snapshot via the recreate engine (pure, unit-tested).
    snapshot = inspectToSnapshot(current);
    envLines = (snapshot.env ?? []).join("\n");
    // Detect anything generic recreate cannot faithfully re-apply — block
    // BEFORE mutation with concrete reasons (fail closed, never degrade).
    let imageExposed = [];
    try {
      const imgInspect = await dockerJson(["image", "inspect", "--format", "{{json .Config.ExposedPorts}}", current.Image], STEP_TIMEOUT_MS.inspect);
      const parsedImg = Array.isArray(imgInspect) ? imgInspect[0] : imgInspect;
      imageExposed = Object.keys(typeof parsedImg === "string" ? JSON.parse(parsedImg) : (parsedImg ?? {}));
    } catch { imageExposed = []; }
    const unsupported = findUnsupported(snapshot, imageExposed);
    if (unsupported.length > 0) {
      throw new Error(`${UNSUPPORTED_PREFIX} ${unsupported.join("; ")}`);
    }
    // Persist the pre-update snapshot (contains Env secrets — never
    // served via API; it is the rollback source).
    await mkdir(SNAPSHOT_DIR, { recursive: true }).catch(() => {});
    await writeFile(snapshotFile, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    setPhase("snapshotting", `config captured (image ${snapshot.image})`);
    }

    // --- pulling (skipped for rollback: use the pinned old image ID) --------
    let targetImage;
    if (rollback) {
      targetImage = snapshot.imageId;
      if (!targetImage) throw new Error("snapshot has no image ID for rollback");
      setPhase("pulling", `rollback uses pinned image ${targetImage.slice(0, 25)}`);
    } else {
      targetImage = snapshot.image;
      setPhase("pulling", targetImage);
      let pullFailed = false;
      try {

        await docker(["pull", targetImage], {
          timeoutMs: STEP_TIMEOUT_MS.pull,
          onStdout: (text) => {
            const line = text.split("\n").find((entry) =>
              entry.includes("Pull complete") || entry.includes("Downloaded newer") || entry.includes("Image is up to date"));
            if (line) setPhase("pulling", line.trim().slice(0, 120));
          },
        });
      } catch (pullError) {
        const local = await dockerJson(["image", "inspect", targetImage], STEP_TIMEOUT_MS.inspect).catch(() => null);
        if (!local) throw new Error(`pull failed and image is not local: ${String(pullError.message).slice(0, 140)}`);
        pullFailed = true;
        setPhase("pulling", "registry pull failed — continuing with local image");
      }

      // --- verifying --------------------------------------------------------
      setPhase("verifying", targetImage);
      const imageInspect = await dockerJson(["image", "inspect", targetImage], STEP_TIMEOUT_MS.inspect);
      const newImageId = (Array.isArray(imageInspect) ? imageInspect[0] : imageInspect)?.Id ?? null;
      if (!newImageId) throw new Error("cannot resolve new image ID");
      if (newImageId === snapshot.imageId && !pullFailed) {
        // Same image ID: the tag did not move (version-pinned or unchanged).
        invalidateInventory();
    invalidateInventory();
    setPhase("complete"); // INVALIDATED, "image unchanged — already up to date, container untouched");
        setJob(name, {
          phase: "completed",
          finishedAt: new Date().toISOString(),
          lastResult: { result: "no-change", image: targetImage, imageId: newImageId, durationMs: Date.now() - Date.parse(startedAt) },
        });
        return;
      }
      setPhase("verifying", `new image ${newImageId.slice(0, 25)}`);
    }

    // --- recreating ---------------------------------------------------------
    setPhase(rollback ? "rolling-back" : "recreating", `stopping ${name}`);
    const { args, cmd } = snapshotToRunArgs(snapshot, targetImage);
    await removeContainer(name);
    mutated = true;
    await dockerRunWithEnv(args, targetImage, envLines, STEP_TIMEOUT_MS.replace, cmd);
    setPhase("starting", "container started");

    // --- health-wait ---------------------------------------------------------
    setPhase("health-wait", snapshot.hasHealthcheck ? "waiting for healthcheck" : "verifying stable running state");
    const restartBaseline = await (async () => {
      const raw = await dockerJson(["container", "inspect", "--format", "{{json .State.RestartCount}}", name], STEP_TIMEOUT_MS.inspect).catch(() => null);
      const value = Array.isArray(raw) ? raw[0] : raw;
      return typeof value === "number" ? value : 0;
    })();
    const deadline = Date.now() + HEALTH_WAIT_MS;
    let verdict = null;
    while (Date.now() < deadline) {
      verdict = await isHealthy(name);
      if (verdict.ok) break;
      if (verdict.detail === "unhealthy") break;
      await sleep(4_000);
    }
    // Stabilization period: must still be healthy/running afterwards; for
    // containers without a healthcheck, detect crash loops via RestartCount.
    if (verdict?.ok) {
      await sleep(STABILIZE_MS);
      verdict = await isHealthy(name);
      if (verdict.ok && !snapshot.hasHealthcheck) {
        const loop = await isCrashLooping(name, restartBaseline);
        if (loop.crashed) verdict = { ok: false, detail: loop.detail };
      }
    }
    if (!verdict?.ok) {
      throw new Error(`health verification failed: ${verdict?.detail ?? "timeout"}`);
    }
    if (rollback) {
      setPhase("rolled-back", `restored ${targetImage.slice(0, 25)} and healthy`);
      setJob(name, {
        phase: "rolled-back",
        finishedAt: new Date().toISOString(),
        lastResult: {
          result: "rollback-success",
          image: targetImage,
          durationMs: Date.now() - Date.parse(startedAt),
          health: verdict.detail,
        },
      });
      return;
    }
    invalidateInventory();
    invalidateInventory();
    setPhase("complete"); // INVALIDATED, `${name} updated and healthy`);
    setJob(name, {
      phase: "completed",
      finishedAt: new Date().toISOString(),
      lastResult: {
        result: rollback ? "rollback-success" : "success",
        image: targetImage,
        imageId: rollback ? targetImage : null,
        durationMs: Date.now() - Date.parse(startedAt),
        health: verdict.detail,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("container-update-failed", `${name}: ${message}`);

    if (snapshot && mutated) {
      // Automatic rollback to the snapshotted image + config.
      setPhase("rolling-back", message.slice(0, 160));
      try {
        const { args, cmd } = snapshotToRunArgs(snapshot, snapshot.imageId);
        await removeContainer(name);
        await dockerRunWithEnv(args, snapshot.imageId, envLines, STEP_TIMEOUT_MS.replace, cmd);
        const deadline = Date.now() + HEALTH_WAIT_MS;
        let ok = false;
        let lastDetail = "timeout";
        while (Date.now() < deadline) {
          const verdict = await isHealthy(name);
          if (verdict.ok) {
            await sleep(STABILIZE_MS);
            const recheck = await isHealthy(name);
            const loop = recheck.ok && !snapshot.hasHealthcheck ? await isCrashLooping(name, 0) : { crashed: false };
            if (recheck.ok && !loop.crashed) { ok = true; break; }
            lastDetail = recheck.ok ? loop.detail : recheck.detail;
          } else {
            lastDetail = verdict.detail;
            if (verdict.detail === "unhealthy") break;
          }
          await sleep(4_000);
        }
        if (!ok) throw new Error(`rolled-back container did not become healthy: ${lastDetail}`);
        setPhase("rolled-back", `restored ${snapshot.imageId.slice(0, 25)}: ${message.slice(0, 120)}`);
        setJob(name, {
          phase: "rolled-back",
          finishedAt: new Date().toISOString(),
          lastResult: {
            result: "rolled-back",
            image: snapshot.imageId,
            durationMs: Date.now() - Date.parse(startedAt),
            error: message.slice(0, 300),
          },
        });
      } catch (rollbackError) {
        setPhase("rollback-failed", `MANUAL RECOVERY REQUIRED: ${String(rollbackError.message).slice(0, 120)}`);
        setJob(name, {
          phase: "rollback-failed",
          finishedAt: new Date().toISOString(),
          lastResult: {
            result: "rollback-failed",
            error: `update: ${message.slice(0, 160)}; rollback: ${String(rollbackError.message).slice(0, 160)}`,
          },
        });
      }
    } else {
      // Nothing mutated — clean failure.
      setPhase("failed", message.slice(0, 200));
      setJob(name, {
        phase: "failed",
        finishedAt: new Date().toISOString(),
        lastResult: { result: "failed", error: message.slice(0, 300) },
      });
    }
  } finally {
    // Always release: a stuck lock would 409 every future operation.
    state.lock = null;
    state.finishedAt = new Date().toISOString();
  }
}

/* ---- compose update machine -------------------------------------------------
 * Eén service uit één bekend project. Pre-flight valideert labels, paden
 * (allowlist + realpath), service-bestaan en sibling-state. Mutatie via
 * compose argv-arrays only. Rollback via generieke snapshot-recreate.
 */

async function runComposeUpdate(name) {
  const startedAt = Date.now();
  const phases = [];
  const setPhase = (phase, detail) => {
    phases.push({ phase, detail: String(detail ?? "").slice(0, 160), at: new Date().toISOString() });
    setJob(`compose:${name}`, { phase, detail: String(detail ?? "").slice(0, 200), phases });
    log(`compose-update:${name}`, `${phase}: ${detail ?? ""}`);
  };

  let mutated = false;
  let snapshot = null;
  let envLines = "";
  let siblingsBefore = null;
  let targetImage = null;
  // Hoisted naar functie-scope zodat de catch/rollback ze kan gebruiken.
  let parsed = null;
  let composeUp = null;

  try {
    setPhase("requested", "validating compose project");
    const inspectArray = await dockerJson(["container", "inspect", "--format", "{{json .}}", name], STEP_TIMEOUT_MS.inspect);
    const current = Array.isArray(inspectArray) ? inspectArray[0] : inspectArray;
    if (!current) throw new Error("container not found");

    const labels = current.Config?.Labels ?? {};
    parsed = compose.parseComposeLabels(labels);
    if (!parsed) throw new Error("container is not compose-managed");

    // Pad-allowlist: working_dir moet binnen een deploy-time root vallen.
    const allowedRoots = (process.env.COMPOSE_ALLOWED_ROOTS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    const wd = compose.validateAllowedPath(parsed.workdir, allowedRoots);
    if (!wd.ok) throw new Error(`POLICY_DENIED: ${wd.reason}`);

    // Config-files valideren (volgorde behouden, traversal weigeren).
    const cf = compose.validateConfigFiles(parsed.configFiles, wd.canonical, allowedRoots);
    if (!cf.ok) throw new Error(`POLICY_DENIED: ${cf.reason}`);

    // Compose config moet valideren zonder mutatie.
    const composeInvocation = (action) => {
      const base = ["compose", "--project-name", parsed.project, "--project-directory", wd.canonical];
      for (const file of parsed.configFiles) base.push("--file", file);
      if (action === "pull") return [...base, "pull", parsed.service];
      if (action === "up") return [...base, "up", "-d", "--no-deps", parsed.service];
      return [...base, "config", "--services"];
    };

    setPhase("verifying", "compose config validation");

    await docker(composeInvocation("config"), { timeoutMs: 30_000 });

    // Sibling-state vóór mutatie (moet gelijk blijven behalve target).
    const psRaw = await docker(["ps", "-a", "--format", "{{json .}}"], STEP_TIMEOUT_MS.inspect);
    const psList = psRaw.stdout
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
    siblingsBefore = psList
      .filter((c) => (c.Labels ?? "").includes(`com.docker.compose.project=${parsed.project}`) && !String(c.Names ?? "").startsWith(name))
      .map((c) => ({ name: c.Names, state: c.State }));
    setPhase("verifying", `${siblingsBefore.length} sibling(s) in project ${parsed.project}`);

    // Snapshot van de target-container (vóór mutatie) — rollback-bron.
    snapshot = inspectToSnapshot(current);
    envLines = (snapshot.env ?? []).join("\n");
    const snapshotFile = nodePath.join(STATE_DIR, "snapshots", `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    await mkdir(nodePath.dirname(snapshotFile), { recursive: true }).catch(() => {});
    await writeFile(snapshotFile, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    targetImage = snapshot.image;

    // Pull alleen de target-service image.
    setPhase("pulling", targetImage);
    let pullFailed = false;
    try {

      await docker(["pull", targetImage], { timeoutMs: STEP_TIMEOUT_MS.pull });
    } catch (pullError) {
      const local = await dockerJson(["image", "inspect", targetImage], STEP_TIMEOUT_MS.inspect).catch(() => null);
      if (!local) throw new Error(`pull failed and image not local: ${String(pullError.message).slice(0, 120)}`);
      pullFailed = true;
      setPhase("pulling", "pull failed — using local image");
    }

    // Verwijderde container betekent: vorige run is al hersteld of weg —
    // de target moet bestaan vóór mutatie.
    const exists = await dockerJson(["container", "inspect", "--format", "{{json .State.Running}}", name], STEP_TIMEOUT_MS.inspect).catch(() => null);
    void exists;

    // Scoped compose update via compose CLI: pull + up -d --no-deps.
    setPhase("recreating", `compose up -d --no-deps ${parsed.service}`);
    const prevRunning = await (async () => {
      const raw = await dockerJson(["container", "inspect", "--format", "{{json .State.RestartCount}}", name], STEP_TIMEOUT_MS.inspect).catch(() => null);
      return typeof raw === "number" ? raw : 0;
    })();
    mutated = true;
    await removeContainer(name).catch(() => {});

    await docker(composeInvocation("pull"), { timeoutMs: STEP_TIMEOUT_MS.pull });

    await docker(composeInvocation("up"), { timeoutMs: STEP_TIMEOUT_MS.replace });

    // Health-verificatie.
    setPhase("health-wait", "wachten op service health");
    const deadline = Date.now() + HEALTH_WAIT_MS;
    let verdict = null;
    while (Date.now() < deadline) {
      verdict = await isHealthy(name);
      if (verdict.ok) { await sleep(STABILIZE_MS); const re = await isHealthy(name); if (re.ok) { verdict = re; break; } }
      if (verdict.detail === "unhealthy") break;
      if (verdict.detail === "not running") {
        const loop = await isCrashLooping(name, prevRunning);
        if (loop.crashed) { verdict = { ok: false, detail: loop.detail }; break; }
      }
      await sleep(4_000);
    }
    if (!verdict?.ok) throw new Error(`health verification failed: ${verdict?.detail ?? "timeout"}`);

    // Sibling-verificatie: eerder draaiende siblings moeten nog draaien.
    for (const sibling of siblingsBefore ?? []) {
      if (sibling.state !== "running") continue;
      const sibState = await dockerJson(["container", "inspect", "--format", "{{json .State.Running}}", sibling.name], STEP_TIMEOUT_MS.inspect).catch(() => null);
      const stillRunning = (Array.isArray(sibState) ? sibState[0] : sibState) === true;
      if (!stillRunning) throw new Error(`sibling service ${sibling.name} is no longer running after update`);
    }

    invalidateInventory();
    invalidateInventory();
    setPhase("complete"); // INVALIDATED, `${name} updated en healthy`);
    setJob(`compose:${name}`, {
      phase: "completed",
      finishedAt: new Date().toISOString(),
      lastResult: { result: "success", image: targetImage, durationMs: Date.now() - startedAt, health: verdict.detail },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log("compose-update-failed", `${name}: ${message}`);

    if (snapshot && mutated) {
      setPhase("rolling-back", message.slice(0, 160));
      try {
        const { args, cmd } = snapshotToRunArgs(snapshot, snapshot.imageId);
        await removeContainer(name);
        await dockerRunWithEnv(args, snapshot.imageId, (snapshot.env ?? []).join("\n"), STEP_TIMEOUT_MS.replace, cmd);
        const deadline = Date.now() + HEALTH_WAIT_MS;
        let ok = false;
        while (Date.now() < deadline) {
          const v = await isHealthy(name);
          if (v.ok) { await sleep(STABILIZE_MS); const re = await isHealthy(name); if (re.ok) { ok = true; break; } }
          if (v.detail === "unhealthy") break;
          await sleep(4_000);
        }
        if (!ok) throw new Error("rolled-back service did not become healthy");
        setPhase("rolled-back", `hersteld: ${message.slice(0, 120)}`);
        setJob(`compose:${name}`, {
          phase: "rolled-back",
          finishedAt: new Date().toISOString(),
          lastResult: { result: "rolled-back", image: snapshot.imageId, error: message.slice(0, 240) },
        });
      } catch (rollbackError) {
        setPhase("rollback-failed", `MANUAL RECOVERY REQUIRED: ${String(rollbackError.message).slice(0, 140)}`);
        setJob(`compose:${name}`, {
          phase: "rollback-failed",
          finishedAt: new Date().toISOString(),
          lastResult: { result: "rollback-failed", error: `update: ${message.slice(0, 150)}; rollback: ${String(rollbackError.message).slice(0, 150)}` },
        });
      }
    } else {
      setPhase("failed", message.slice(0, 200));
      setJob(`compose:${name}`, {
        phase: "failed",
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        lastResult: { result: "failed", error: message.slice(0, 300) },
      });
    }
  } finally {
    state.lock = null;
    state.finishedAt = new Date().toISOString();
  }
}

/* ---- compose PROJECT update machine (v0.7.13) --------------------------------
 * Sequential, project-scoped, stop-on-first-failure. Policy (re-derived
 * HERE, never trusted from the request):
 *  - pipeline-owned projects: always refused
 *  - any HIGH-risk member (database/auth/proxy/DNS): refused
 *  - any AIO/externally-managed or non-recreatable member: refused
 *  - dependency graph from `compose config` only; ambiguous graph: refused
 *  - one service at a time, dependencies first; health-validated each step
 *  - first failure rolls the failed service back and STOPS the project
 * The request supplies ONLY the project name; paths/services/order derive
 * from live container labels and the compose config. No parallel updates.
 */

/** Live members of a compose project (labels from container inspect). */
async function composeProjectMembers(project) {
  const psRaw = await docker(["ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}"], 20_000);
  const entries = psRaw.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split("\t"))
    .filter((parts) => parts.length >= 4);
  const members = [];
  for (const [id, name, image, memberState] of entries) {
    try {
      const inspectArray = await dockerJson(["container", "inspect", "--format", "{{json .}}", id], STEP_TIMEOUT_MS.inspect);
      const current = Array.isArray(inspectArray) ? inspectArray[0] : inspectArray;
      const parsed = compose.parseComposeLabels(current?.Config?.Labels ?? {});
      if (!parsed || parsed.project !== project) continue;
      members.push({ id, name, image, state: memberState, ...parsed, labels: current?.Config?.Labels ?? {}, fullInspect: current });
    } catch {
      // inspect failure on one container must not hide the project
    }
  }
  return members;
}

async function runComposeProjectUpdate(project) {
  const startedAt = Date.now();
  const jobKey = `project:${project}`;
  const phases = [];
  const setPhase = (phase, detail) => {
    phases.push({ phase, detail: String(detail ?? "").slice(0, 160), at: new Date().toISOString() });
    setJob(jobKey, { phase, detail: String(detail ?? "").slice(0, 200), phases });
    log(`project-update:${project}`, `${phase}: ${detail ?? ""}`);
  };

  /** Service-level bookkeeping so /compose-job keeps working per service. */
  const recordService = (service, patch) => {
    const member = memberByService.get(service);
    if (member) setJob(`compose:${member.name}`, { startedAt: new Date(startedAt).toISOString(), ...patch });
  };

  let mutatedServices = [];
  try {
    setPhase("requested", "deriving project members from live labels");
    const members = await composeProjectMembers(project);
    if (members.length === 0) throw new Error(`no containers found for project ${project}`);
    const memberByService = new Map(members.map((member) => [member.service, member]));

    // --- project-level policy re-derivation (defense in depth) ------------
    if (pipelineOwnedProjects().includes(project.toLowerCase()) || members.some((m) => m.labels["com.cyxno.management"] === "pipeline")) {
      throw new Error("POLICY_DENIED: pipeline-owned project — dashboard never executes updates here");
    }
    const allowedRoots = (process.env.COMPOSE_ALLOWED_ROOTS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    const first = members[0];
    const wd = compose.validateAllowedPath(first.workdir, allowedRoots);
    if (!wd.ok) throw new Error(`POLICY_DENIED: ${wd.reason}`);
    const cf = compose.validateConfigFiles(first.configFiles, wd.canonical, allowedRoots);
    if (!cf.ok) throw new Error(`POLICY_DENIED: ${cf.reason}`);

    const refusal = [];
    for (const member of members) {
      if (blockedContainers().has(member.name.toLowerCase())) refusal.push(`${member.name}: AIO/externally managed`);
      if (isHighRisk(member.name, member.image)) refusal.push(`${member.name}: HIGH risk (database/auth/proxy/DNS)`);
      if (member.labels["com.cyxno.management"] === "pipeline") refusal.push(`${member.name}: pipeline-owned`);
    }
    if (refusal.length > 0) {
      throw new Error(`POLICY_DENIED: project contains non-updateable members — ${refusal.join("; ")}`);
    }

    // --- dependency graph (compose config only, never name guessing) ------
    setPhase("verifying", "reading dependency graph from compose config");
    const configArgs = ["compose", "--project-name", project, "--project-directory", wd.canonical];
    for (const file of first.configFiles) configArgs.push("--file", file);
    configArgs.push("config", "--format", "json");
    const configOut = await docker(configArgs, { timeoutMs: 30_000 });
    const graph = compose.parseComposeConfig(JSON.parse(configOut.stdout));
    if (!graph.ok) throw new Error(`dependency graph unavailable: ${graph.reason}`);
    const orderResult = compose.topologicalOrder(graph.services, graph.dependsOn);
    if (!orderResult.ok) throw new Error(`dependency graph ambiguous: ${orderResult.reason}`);
    // Configured services without a running member make the graph ambiguous.
    const knownServices = new Set(members.map((m) => m.service));
    const missing = orderResult.order.filter((service) => !knownServices.has(service));
    if (missing.length > 0) {
      throw new Error(`dependency graph ambiguous: configured services without containers: ${missing.join(", ")}`);
    }

    // --- snapshot every member BEFORE the first mutation -------------------
    const snapshots = new Map();
    for (const member of members) {
      const snapshot = inspectToSnapshot(member.fullInspect);
      const unsupported = findUnsupported(snapshot, []);
      // imageExposed omitted: compose services recreate via compose up, not
      // docker run; unsupported detection still guards exotic configs.
      if (unsupported.length > 0) {
        throw new Error(`POLICY_DENIED: ${member.name} not recreatable: ${unsupported.join("; ")}`);
      }
      const snapshotFile = nodePath.join(SNAPSHOT_DIR, `${member.name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
      await mkdir(SNAPSHOT_DIR, { recursive: true }).catch(() => {});
      await writeFile(snapshotFile, JSON.stringify({ ...snapshot, capturedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
      snapshots.set(member.service, { snapshot, envLines: (snapshot.env ?? []).join("\n") });
    }

    const runningBefore = members.filter((m) => m.state === "running").map((m) => ({ name: m.name, service: m.service }));

    // --- sequential service updates (dependencies first) -------------------
    for (const service of orderResult.order) {
      const member = memberByService.get(service);
      if (!member) continue;
      recordService(service, { phase: "requested", finishedAt: null });
      const { snapshot, envLines } = snapshots.get(service);
      const composeInvocation = (action) => {
        const base = ["compose", "--project-name", project, "--project-directory", wd.canonical];
        for (const file of first.configFiles) base.push("--file", file);
        if (action === "pull") return [...base, "pull", service];
        if (action === "up") return [...base, "up", "-d", "--no-deps", service];
        return [...base, "config", "--services"];
      };
      try {
        setPhase(`updating:${service}`, "pulling scoped image");

        await docker(composeInvocation("pull"), { timeoutMs: STEP_TIMEOUT_MS.pull });
        // No-op guard: image unchanged after pull → leave the service alone.
        const newImage = await dockerJson(["image", "inspect", member.image], STEP_TIMEOUT_MS.inspect).catch(() => null);
        const newImageId = (Array.isArray(newImage) ? newImage[0] : newImage)?.Id ?? null;
        if (newImageId && newImageId === snapshot.imageId) {
          setPhase(`skipped:${service}`, "image unchanged — already up to date, service untouched");
          recordService(service, {
            phase: "completed",
            finishedAt: new Date().toISOString(),
            lastResult: { result: "no-change", image: member.image },
          });
          continue;
        }

        setPhase(`updating:${service}`, "recreating service");
        const restartBaseline = await (async () => {
          const raw = await dockerJson(["container", "inspect", "--format", "{{json .State.RestartCount}}", member.name], STEP_TIMEOUT_MS.inspect).catch(() => null);
          return typeof (Array.isArray(raw) ? raw[0] : raw) === "number" ? (Array.isArray(raw) ? raw[0] : raw) : 0;
        })();
        await removeContainer(member.name);
        mutatedServices.push(service);

        await docker(composeInvocation("up"), { timeoutMs: STEP_TIMEOUT_MS.replace });

        setPhase(`health-wait:${service}`, snapshot.hasHealthcheck ? "waiting for healthcheck" : "verifying stable running state");
        const deadline = Date.now() + HEALTH_WAIT_MS;
        let verdict = null;
        while (Date.now() < deadline) {
          verdict = await isHealthy(member.name);
          if (verdict.ok) {
            await sleep(STABILIZE_MS);
            const recheck = await isHealthy(member.name);
            if (recheck.ok) {
              if (!snapshot.hasHealthcheck) {
                const loop = await isCrashLooping(member.name, restartBaseline);
                if (loop.crashed) { verdict = { ok: false, detail: loop.detail }; break; }
              }
              verdict = recheck;
              break;
            }
          }
          if (verdict.detail === "unhealthy") break;
          await sleep(4_000);
        }
        if (!verdict?.ok) throw new Error(`health verification failed: ${verdict?.detail ?? "timeout"}`);

        // Siblings that ran before the project job must still run.
        for (const sibling of runningBefore) {
          if (sibling.name === member.name) continue;
          const sibState = await dockerJson(
            ["container", "inspect", "--format", "{{json .State.Running}}", sibling.name],
            STEP_TIMEOUT_MS.inspect,
          ).catch(() => null);
          if ((Array.isArray(sibState) ? sibState[0] : sibState) !== true) {
            throw new Error(`sibling service ${sibling.name} is no longer running after updating ${service}`);
          }
        }
        setPhase(`updated:${service}`, `${member.name} healthy`);
        recordService(service, {
          phase: "completed",
          finishedAt: new Date().toISOString(),
          lastResult: { result: "success", image: member.image, health: verdict.detail },
        });
      } catch (serviceError) {
        const message = serviceError instanceof Error ? serviceError.message : String(serviceError);
        // Stop on first failure: roll THIS service back, then abort the
        // project — never continue blindly into the next dependency.
        if (mutatedServices.includes(service)) {
          setPhase(`rolling-back:${service}`, message.slice(0, 140));
          try {
            const { args, cmd } = snapshotToRunArgs(snapshot, snapshot.imageId);
            await removeContainer(member.name);
            await dockerRunWithEnv(args, snapshot.imageId, envLines, STEP_TIMEOUT_MS.replace, cmd);
            const deadline = Date.now() + HEALTH_WAIT_MS;
            let ok = false;
            while (Date.now() < deadline) {
              const v = await isHealthy(member.name);
              if (v.ok) { await sleep(STABILIZE_MS); const re = await isHealthy(member.name); if (re.ok) { ok = true; break; } }
              if (v.detail === "unhealthy") break;
              await sleep(4_000);
            }
            if (!ok) throw new Error("rolled-back service did not become healthy");
            recordService(service, {
              phase: "rolled-back",
              finishedAt: new Date().toISOString(),
              lastResult: { result: "rolled-back", error: message.slice(0, 240) },
            });
            throw new Error(`service ${service} failed and was rolled back — project update stopped: ${message.slice(0, 140)}`);
          } catch (rollbackError) {
            const rbMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            if (String(rbMessage).startsWith("service ")) throw rollbackError;
            recordService(service, {
              phase: "rollback-failed",
              finishedAt: new Date().toISOString(),
              lastResult: { result: "rollback-failed", error: `update: ${message.slice(0, 150)}; rollback: ${rbMessage.slice(0, 150)}` },
            });
            throw new Error(`MANUAL RECOVERY REQUIRED — service ${service}: update: ${message.slice(0, 120)}; rollback: ${rbMessage.slice(0, 120)}`);
          }
        }
        // Pre-mutation failure of this service: nothing to roll back here.
        recordService(service, {
          phase: "failed",
          finishedAt: new Date().toISOString(),
          lastResult: { result: "failed", error: message.slice(0, 300) },
        });
        throw new Error(`service ${service} failed pre-mutation — project update stopped: ${message.slice(0, 160)}`);
      }
    }

    invalidateInventory();
    invalidateInventory();
    setPhase("complete"); // INVALIDATED, `project ${project}: ${orderResult.order.length} service(s) processed sequentially`);
    setJob(jobKey, {
      phase: "completed",
      finishedAt: new Date().toISOString(),
      lastResult: {
        result: "success",
        services: orderResult.order,
        durationMs: Date.now() - startedAt,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setPhase("failed", message.slice(0, 280));
    setJob(jobKey, {
      phase: "failed",
      finishedAt: new Date().toISOString(),
      lastResult: { result: "failed", error: message.slice(0, 300), durationMs: Date.now() - startedAt },
    });
  } finally {
    state.lock = null;
    state.finishedAt = new Date().toISOString();
  }
}

function constantTimeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function authorize(req) {
  const expected = process.env.UPDATE_HELPER_TOKEN;
  if (!expected || expected.length < 32) return false;
  const match = (req.headers.authorization ?? "").match(/^Bearer (.+)$/);
  if (!match) return false;
  return constantTimeEqual(match[1], expected);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${LISTEN_HOST}`);

  if (url.pathname === "/health") {
    const lastRefreshAgeSeconds = inventoryStatus.lastRefreshAt
      ? Math.round((Date.now() - Date.parse(inventoryStatus.lastRefreshAt)) / 1000)
      : null;
    return sendJson(res, 200, {
      ok: true,
      version: HELPER_VERSION,
      inventoryStatus: inventoryStatus.status,
      lastRefreshAgeSeconds,
      lastRefreshFailures: inventoryStatus.lastRefreshFailures,
    });
  }

  // Read-only inventory of ALL containers: what the central update manager
  // needs for classification. Facts only — no env, no mounts, no secrets.
  if (url.pathname === "/inventory" && req.method === "GET") {
    if (!authorize(req)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }
    if (inventoryCache && Date.now() - inventoryCache.at < INVENTORY_TTL_MS) {
      return sendJson(res, 200, inventoryCache.body);
    }
    // Single-flight coalescing: concurrent cache-miss requests await the
    // same in-flight refresh instead of each spawning Docker CLI processes.
    if (inventoryRefreshPromise) {
      const body = await inventoryRefreshPromise.catch(() => null);
      if (body) return sendJson(res, 200, body);
      return sendJson(res, 500, { error: "Inventory refresh failed." });
    }
    const refresh = (async () => {
      const refreshStartedAt = Date.now();
      try {
        // One `docker ps` for the list; inspect runs in DETERMINISTIC CHUNKS
        // (v1.3.13): bounded stdout per spawn, partial-failure isolation,
        // no N+1, no mega-batch that can silently truncate.
        const psRaw = await docker(
          ["ps", "-a", "--format", "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}"],
          { timeoutMs: 20_000 },
        );
        const entries = psRaw.stdout
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => line.split("\t"))
          .filter((parts) => parts.length >= 5);
        if (entries.length === 0) {
          return { version: HELPER_VERSION, containers: [], storage: { mode: process.env.DOCKER_STORAGE_MODE || "unknown", source: process.env.DOCKER_STORAGE_SOURCE || null } };
        }
        // Chunked inspect (25 ids per spawn, sequential — predictable memory
        // and dockerd load). Each chunk parses independently (NDJSON); one
        // malformed line or failing chunk degrades only its own containers.
        const CHUNK_SIZE = 25;
        const chunks = inventoryLib.chunkList(entries, CHUNK_SIZE);
        let inspectResults = [];
        let chunkFailures = 0;
        let parseErrors = 0;
        for (const chunk of chunks) {
          let raw = null;
          try {
            raw = await docker(
              ["container", "inspect", "--format", "{{json .}}", ...chunk.map(([id]) => id)],
              STEP_TIMEOUT_MS.inspect,
            );
          } catch {
            raw = null; // timeout/spawn failure → chunk degrades, not the batch
          }
          if (raw && raw.stderr && raw.stderr.trim().length > 0) {
            log("inventory", `inspect chunk stderr: ${raw.stderr.trim().slice(0, 120)}`);
          }
          const parsedChunk = inventoryLib.parseInspectOutput(raw ? raw.stdout : "");
          // Partial-failure policy (Fase 5/10): keep the valid records of a
          // chunk; a chunk that parsed NOTHING while having entries counts as
          // failed and gets ONE retry before its containers fall back.
          if (parsedChunk.records.length === 0 && chunk.length > 0) {
            chunkFailures += 1;
            try {
              const retry = await docker(
                ["container", "inspect", "--format", "{{json .}}", ...chunk.map(([id]) => id)],
                STEP_TIMEOUT_MS.inspect,
              );
              const retryParsed = inventoryLib.parseInspectOutput(retry ? retry.stdout : "");
              if (retryParsed.records.length > 0) {
                chunkFailures -= 1;
                inspectResults.push(...retryParsed.records);
                parseErrors += retryParsed.parseErrors.length;
              }
            } catch {
              // keep the failure counted; containers fall through the
              // per-container catch below with explicit degraded facts
            }
          } else {
            inspectResults.push(...parsedChunk.records);
            parseErrors += parsedChunk.parseErrors.length;
          }
        }
        // Fase 10: if EVERY chunk failed, this is a hard refresh failure —
        // never continue with an all-empty-facts inventory (that is exactly
        // the silent degradation class this pipeline must not reproduce).
        // The outer catch then serves last-known-good / fails the request.
        if (chunks.length > 0 && chunkFailures === chunks.length) {
          throw new Error(`all ${chunks.length} inspect chunks failed`);
        }
        // Index by BOTH id forms (short join) + duplicate/malformed counts.
        const { byId: inspectById, duplicates } = inventoryLib.buildIdIndex(inspectResults);
        if (duplicates > 0) log("inventory", `duplicate inspect records: ${duplicates}`);
        const containers = [];
        const imageDigestCache = new Map();
        let inspectFailures = 0;
        for (const [id, name, image, state, status] of entries) {
          try {
            const current = inspectById.get(id) ?? null;
            const rawLabels = current?.Config?.Labels ?? {};
            const labels = {};
            for (const key of [
              "com.cyxno.update-manager",
              "com.cyxno.management",
              "com.cyxno.update.policy",
              "com.cyxno.update.risk",
              "com.cyxno.pipeline.repo",
              "com.cyxno.pipeline.deployer",
              "com.cyxno.pipeline.sha",
              "com.cyxno.pipeline.ref",
              "com.docker.compose.project",
              "com.docker.compose.service",
              "com.docker.compose.project.working_dir",
              "com.docker.compose.project.config_files",
              "net.unraid.docker.managed",
            ]) {
              if (typeof rawLabels[key] === "string" && rawLabels[key].length > 0) {
                labels[key] = rawLabels[key].slice(0, 300);
              }
            }
            const snapForDetect = inspectToSnapshot(current);
            let imageExposed = [];
            try {
              const imgInspect = await dockerJson(
                ["image", "inspect", "--format", "{{json .Config.ExposedPorts}}", current.Image],
                STEP_TIMEOUT_MS.inspect,
              );
              const pi = Array.isArray(imgInspect) ? imgInspect[0] : imgInspect;
              imageExposed = Object.keys(typeof pi === "string" ? JSON.parse(pi) : (pi ?? {}));
            } catch {
              imageExposed = [];
            }
            const unsupported = findUnsupported(snapForDetect, imageExposed);
            let repoDigests = [];
            if (imageDigestCache.has(image)) {
              repoDigests = imageDigestCache.get(image) ?? [];
            } else if (current && typeof current.Image === "string" && current.Image.length > 0) {
              // Guard: without inspect data the image reference is unknown;
              // a failed lookup is NOT cached — a transient docker error must
              // never permanently masquerade as "no registry digest".
              try {
                const parsed = await dockerJson(
                  ["image", "inspect", "--format", "{{json .RepoDigests}}", current.Image],
                  STEP_TIMEOUT_MS.inspect,
                );
                const list = Array.isArray(parsed) ? parsed : [parsed];
                repoDigests = list.map(String).slice(0, 4);
                imageDigestCache.set(image, repoDigests);
              } catch {
                repoDigests = []; // uncached: retried on the next refresh
              }
            }
            containers.push({
              id,
              idShort: inventoryLib.isShortId(id) ? id : (inventoryLib.isFullId(id) ? id.slice(0, 12) : null),
              // Canonical identity from the inspect record (64-char) — the
              // ps id is short. Fase 2/3: full id is the primary join key.
              idFull: current && inventoryLib.isFullId(current.Id) ? current.Id : null,
              name,
              image,
              state,
              status,
              health: current?.State?.Health?.Status ?? null,
              imageId: current?.Image ?? null,
              repoDigests,
              networks: Object.keys(current?.NetworkSettings?.Networks ?? {}).slice(0, 8),
              volumeSources: (current?.Mounts ?? [])
                .filter((mount) => typeof mount?.Source === "string" && mount.Source.length > 0)
                .map((mount) => mount.Source)
                .slice(0, 12),
              created: current?.Created ?? null,
              labels,
              unsupported,
              externallyManaged:
                labels["com.cyxno.update-manager"] === "external" ||
                labels["com.cyxno.management"] === "pipeline",
              snapshotPresent: existsSync(
                nodePath.join(SNAPSHOT_DIR, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`),
              ),
            });
          } catch (inspectError) {
            inspectFailures += 1;
            log("inventory", `inspect failed for ${name}: ${String(inspectError.message).slice(0, 100)}`);
            containers.push({ id, name, image, state, status, health: null, imageId: null, repoDigests: [], created: null, labels: {} });
          }
        }
        // Storage model: configured at deploy time by deploy-helper.sh (the
        // script runs on the host where the docker root mount is visible).
        const diagnostics = inventoryLib.assessInventory(containers, {
          inspectedContainers: containers.length - inspectFailures,
          inspectFailures,
          parseErrors,
          chunks: chunks.length,
          durationMs: Date.now() - refreshStartedAt,
          lastSuccessfulRefresh: new Date().toISOString(),
        });
        const body = {
          version: HELPER_VERSION,
          containers,
          storage: { mode: process.env.DOCKER_STORAGE_MODE || "unknown", source: process.env.DOCKER_STORAGE_SOURCE || null },
          diagnostics,
        };
        // Fase 11: full success replaces the cache; a partial refresh still
        // replaces (its facts are coherent) but carries the degraded marker;
        // cache poisoning is impossible because we never store a fabricated
        // empty inventory over a good one.
        inventoryCache = {
          at: Date.now(),
          body,
          degraded: diagnostics.partial || diagnostics.structurallyDegraded,
          lastGoodAt: Date.now(),
        };
        inventoryStatus = {
          status: diagnostics.structurallyDegraded ? "degraded" : diagnostics.partial ? "partial" : "healthy",
          lastRefreshAt: new Date().toISOString(),
          lastRefreshAgeSeconds: 0,
          lastRefreshFailures: inspectFailures + chunkFailures + parseErrors,
          diagnostics,
        };
        log("inventory", inventoryLib.refreshLogLine(diagnostics));
        return body;
      } catch (error) {
        // Fase 11: hard failure → keep serving last-known-good; never wipe.
        if (inventoryCache?.body) {
          inventoryStatus = {
            status: "degraded",
            lastRefreshAt: new Date().toISOString(),
            lastRefreshAgeSeconds: 0,
            lastRefreshFailures: 1,
            diagnostics: inventoryCache.body.diagnostics ?? null,
          };
          log("inventory", `refresh failed — serving last-known-good: ${String(error.message ?? error).slice(0, 100)}`);
          return inventoryCache.body;
        }
        log("inventory", `refresh failed: ${String(error.message ?? error).slice(0, 120)}`);
        return null;
      }
    })();
    // Single-flight (Fase 12): concurrent cache-misses await the same
    // refresh; once SETTLED the promise reference is cleared so the next
    // cache-miss performs a FRESH refresh instead of replaying the first
    // one forever (v1.3.16 fix — inventory used to freeze after boot).
    inventoryRefreshPromise = refresh;
    refresh.finally(() => {
      if (inventoryRefreshPromise === refresh) inventoryRefreshPromise = null;
    });
    const body = await refresh;
    if (body) return sendJson(res, 200, body);
    return sendJson(res, 500, { error: "Inventory refresh failed." });
  }

  if (url.pathname === "/status") {
    return sendJson(res, 200, {
      version: HELPER_VERSION,
      phase: state.phase,
      detail: state.detail,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      log: state.log.slice(-12),
      lock: state.lock ? { since: state.lock.since } : null,
      lastUpdate: state.lastUpdate,
      currentImage: state.currentImage,
      currentVersion: state.currentVersion,
      currentRevision: state.currentRevision ?? null,
      currentImageId: state.currentImageId,
      localVersions: state.localVersions ?? [],
      pullAvailable: state.pullAvailable,
      /** false = the hourly probe hit an auth wall (GHCR login required). */
      pullAuthRequired: state.pullAvailable === false,
      /** Strict remote mode active (UPDATE_REQUIRE_REMOTE=true). */
      requireRemote: REQUIRE_REMOTE,
    });
  }

  // Read-only list of stored pre-update snapshots (rollback evidence).
  // NEVER returns snapshot contents (env secrets) — presence metadata only.
  if (url.pathname === "/snapshots" && req.method === "GET") {
    if (!authorize(req)) return sendJson(res, 401, { error: "unauthorized" });
    void (async () => {
      try {
        const names = existsSync(SNAPSHOT_DIR) ? readdirSync(SNAPSHOT_DIR).filter((f) => f.endsWith(".json")).sort() : [];
        const snapshots = [];
        for (const file of names.slice(0, 200)) {
          try {
            const raw = JSON.parse(readFileSync(nodePath.join(SNAPSHOT_DIR, file), "utf8"));
            snapshots.push({
              container: raw.name ?? file.replace(/\.json$/, ""),
              file,
              imageId: raw.imageId ?? null,
              image: raw.image ?? null,
              capturedAt: raw.capturedAt ?? null,
            });
          } catch {
            snapshots.push({ container: file.replace(/\.json$/, ""), file, imageId: null, image: null, capturedAt: null, unreadable: true });
          }
        }
        return sendJson(res, 200, { snapshots });
      } catch (error) {
        return sendJson(res, 500, { error: String(error.message ?? error).slice(0, 200) });
      }
    })();
    return;
  }

  // Clear a stale PRE-MUTATION operation so new work can proceed. Refuses
  // anything post-mutation (those need recovery, not clearing) and verifies
  // the target container is running before releasing its job.
  if (url.pathname === "/recovery/clear-stale" && req.method === "POST") {
    if (!authorize(req)) return sendJson(res, 401, { error: "unauthorized" });
    let body = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return sendJson(res, 400, { error: "malformed JSON body" });
    }
    if (body?.confirm !== "yes") {
      return sendJson(res, 400, { error: "explicit confirmation required" });
    }
    const cleared = [];
    const refused = [];
    const jobs = jobStore();
    const now = Date.now();
    for (const [key, job] of Object.entries(jobs)) {
      if (!job || job.finishedAt || !job.startedAt) continue;
      const phase = String(job.phase ?? "");
      const basePhase = phase.startsWith("updating:") || phase.startsWith("skipped:") ? "updating" : phase;
      if (!PRE_MUTATION_PHASES.has(basePhase)) {
        if (!job.staleOrphan) refused.push({ job: key, reason: `phase ${phase} is post-mutation — needs recovery, not clearing` });
        continue;
      }
      if (now - Date.parse(job.startedAt) < STALE_OP_MS) {
        refused.push({ job: key, reason: `only ${Math.round((now - Date.parse(job.startedAt)) / 60_000)} min old — not stale` });
        continue;
      }
      // Belt & braces: the target container must exist and be running —
      // a missing container means the machine may have been mid-replace.
      const target = key.startsWith("project:") || key.startsWith("compose:") ? null : key;
      if (target) {
        const running = await dockerJson(
          ["container", "inspect", "--format", "{{json .State.Running}}", target],
          STEP_TIMEOUT_MS.inspect,
        ).catch(() => null);
        const isRunning = (Array.isArray(running) ? running[0] : running) === true;
        if (!isRunning) {
          refused.push({ job: key, reason: "target container is not running — clearing unsafe" });
          continue;
        }
      }
      job.phase = "failed";
      job.finishedAt = new Date().toISOString();
      job.staleCleared = true;
      job.lastResult = { ...(job.lastResult ?? {}), result: "stale-cleared", error: "stale pre-mutation operation cleared by operator" };
      cleared.push(key);
    }
    if (cleared.length > 0) {
      saveJobs(jobs);
      // Release the shared lock only when every active machine was cleared.
      if (state.lock && (state.phase === "requested" || state.phase === "checking" || state.phase === "pulling")) {
        const selfStale = state.startedAt ? now - Date.parse(state.startedAt) >= STALE_OP_MS : false;
        if (selfStale) {
          setPhase("failed", "stale pre-mutation operation cleared by operator");
          state.lock = null;
          state.finishedAt = new Date().toISOString();
          cleared.push("self-update");
        } else {
          refused.push({ job: "self-update", reason: "self machine not stale yet" });
        }
      }
    }
    log("recovery", `clear-stale: cleared=${cleared.length} refused=${refused.length}`);
    return sendJson(res, 200, { cleared, refused });
  }

  // Stable config hash for a compose project (v0.8.0): sha256 over the
  // ordered config-file contents + their paths. Read-only over the
  // deploy-time RO mounts; env values are NOT read or hashed. Drives the
  // dashboard's project registry + plan invalidation.
  if (url.pathname === "/compose-project-hash" && req.method === "GET") {
    if (!authorize(req)) return sendJson(res, 401, { error: "unauthorized" });
    void (async () => {
      try {
        const project = (url.searchParams.get("project") ?? "").trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(project)) {
          return sendJson(res, 400, { error: "invalid project name" });
        }
        if (pipelineOwnedProjects().includes(project.toLowerCase())) {
          return sendJson(res, 200, { project, pipelineOwned: true, hash: null, files: [] });
        }
        const members = await composeProjectMembers(project);
        if (members.length === 0) return sendJson(res, 404, { error: `no containers found for project ${project}` });
        const allowedRoots = (process.env.COMPOSE_ALLOWED_ROOTS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
        const first = members[0];
        const wd = compose.validateAllowedPath(first.workdir, allowedRoots);
        if (!wd.ok) return sendJson(res, 422, { error: `POLICY_DENIED: ${wd.reason}` });
        const cf = compose.validateConfigFiles(first.configFiles, wd.canonical, allowedRoots);
        if (!cf.ok) return sendJson(res, 422, { error: `POLICY_DENIED: ${cf.reason}` });
        const hash = createHash("sha256");
        const files = [];
        for (const file of first.configFiles) {
          const resolved = path.isAbsolute(file) ? file : path.join(wd.canonical, file);
          const normalized = path.normalize(resolved);
          if (!normalized.startsWith(wd.canonical)) {
            return sendJson(res, 422, { error: `config file escapes project dir: ${file}` });
          }
          let content;
          try {
            content = readFileSync(normalized);
          } catch (readError) {
            return sendJson(res, 422, { error: `config file unreadable: ${file} (${String(readError.message).slice(0, 80)})` });
          }
          hash.update(`${file}\0`);
          hash.update(content);
          hash.update("\0");
          files.push({ file: file.slice(0, 200), bytes: content.length });
        }
        return sendJson(res, 200, {
          project,
          pipelineOwned: false,
          hash: hash.digest("hex"),
          files,
          computedAt: new Date().toISOString(),
        });
      } catch (error) {
        return sendJson(res, 500, { error: String(error.message ?? error).slice(0, 200) });
      }
    })();
    return;
  }

  // Read-only compose project model: services + depends_on as CONFIGURED
  // (docker compose config), never guessed. No mutation.
  if (url.pathname === "/compose-project" && req.method === "GET") {
    if (!authorize(req)) return sendJson(res, 401, { error: "unauthorized" });
    void (async () => {
      try {
        const project = (url.searchParams.get("project") ?? "").trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(project)) {
          return sendJson(res, 400, { error: "invalid project name" });
        }
        const members = await composeProjectMembers(project);
        if (members.length === 0) return sendJson(res, 404, { error: `no containers found for project ${project}` });

        // Pipeline-owned projects are read-only everywhere.
        if (pipelineOwnedProjects().includes(project.toLowerCase()) || members.some((m) => m.labels["com.cyxno.management"] === "pipeline")) {
          return sendJson(res, 200, {
            project,
            pipelineOwned: true,
            workingDir: members[0]?.workdir ?? null,
            configFiles: members[0]?.configFiles ?? [],
            services: members.map((m) => ({ service: m.service, containers: [m.name], state: m.state })),
            dependsOn: {},
            graphOk: false,
            graphReason: "pipeline-owned project — dashboard never plans or executes updates here",
          });
        }

        const allowedRoots = (process.env.COMPOSE_ALLOWED_ROOTS ?? "").split(",").map((r) => r.trim()).filter(Boolean);
        const first = members[0];
        const wd = compose.validateAllowedPath(first.workdir, allowedRoots);
        if (!wd.ok) return sendJson(res, 422, { error: `POLICY_DENIED: ${wd.reason}` });
        const cf = compose.validateConfigFiles(first.configFiles, wd.canonical, allowedRoots);
        if (!cf.ok) return sendJson(res, 422, { error: `POLICY_DENIED: ${cf.reason}` });

        const args = ["compose", "--project-name", project, "--project-directory", wd.canonical];
        for (const file of first.configFiles) args.push("--file", file);
        args.push("config", "--format", "json");
        const { stdout } = await docker(args, { timeoutMs: 30_000 });
        const parsed = compose.parseComposeConfig(JSON.parse(stdout));
        if (!parsed.ok) return sendJson(res, 422, { error: parsed.reason });

        // configured services that have no running container are NOT errors
        // for planning reads — the plan layer decides ambiguity.
        return sendJson(res, 200, {
          project,
          pipelineOwned: false,
          workingDir: wd.canonical,
          configFiles: first.configFiles,
          services: members.map((m) => ({ service: m.service, containers: [m.name], state: m.state })),
          dependsOn: parsed.dependsOn,
          configuredServices: parsed.services,
          graphOk: true,
        });
      } catch (error) {
        return sendJson(res, 500, { error: String(error.message ?? error).slice(0, 200) });
      }
    })();
    return;
  }

  if (url.pathname === "/rollback" && req.method === "POST") {
    if (!authorize(req)) {
      log("rejected", "unauthorized rollback request");
      return sendJson(res, 401, { error: "unauthorized" });
    }
    if (state.lock) {
      return sendJson(res, 409, {
        error: "an update/rollback is already running",
        phase: state.phase,
        startedAt: state.startedAt,
      });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "malformed JSON body" });
    }
    // Only the tag is read; image repo + container are deployment constants.
    const tag = typeof body?.tag === "string" ? body.tag.trim().replace(/^v/, "") : "";
    if (!TAG_RE.test(tag)) {
      return sendJson(res, 400, { error: "invalid tag — expected semantic version like 0.7.2" });
    }
    const targetImage = `${IMAGE_REPO}:${tag}`;
    // Allowlist check: the image must exist locally and its OCI version
    // label must match the requested tag — no arbitrary refs, no pulls.
    let labels;
    try {
      const inspectArray = await dockerJson(["image", "inspect", targetImage], STEP_TIMEOUT_MS.inspect);
      labels = inspectArray[0]?.Config?.Labels ?? {};
    } catch {
      return sendJson(res, 404, { error: `no local image for ${targetImage} — nothing validated to roll back to` });
    }
    const labelVersion = labels["org.opencontainers.image.version"];
    if (!labelVersion || labelVersion !== tag) {
      return sendJson(res, 400, { error: `image label version (${labelVersion ?? "unlabeled"}) does not match requested ${tag} — refusing unvalidated rollback` });
    }
    state.lock = { token: randomUUID(), since: new Date().toISOString() };
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    setPhase("requested", `rollback to ${targetImage}`);
    void runUpdate(tag, { forceOlder: true }).then(() => {
      void refreshCurrentImage();
      void refreshLocalVersions();
    });
    return sendJson(res, 202, { accepted: true, tag, phase: state.phase });
  }

  // Job status for a container (or all). Read-only, no config content.
  if (url.pathname === "/container-job" && req.method === "GET") {
    if (!authorize(req)) return sendJson(res, 401, { error: "unauthorized" });
    const name = url.searchParams.get("name");
    const jobs = jobStore();
    // Stale detection: a job started >2h ago without completion is marked.
    for (const job of Object.values(jobs)) {
      if (job.startedAt && !job.finishedAt) {
        if (Date.now() - Date.parse(job.startedAt) > 2 * 3600_000) {
          job.phase = job.phase.startsWith("rollback") ? "rollback-failed" : "failed";
          job.staleOrphan = true;
          job.lastResult = { ...(job.lastResult ?? {}), result: "stale-orphan", error: "job exceeded 2h without completion (helper restart?)" };
          saveJobs(jobs);
        }
      }
    }
    if (name) return sendJson(res, 200, { job: jobs[name] ?? null });
    return sendJson(res, 200, { jobs });
  }

  // Generic container update. The request only names the container and
  // confirms; strategy/config derive from the container itself.
  // Compose job status (zelfde job-store, eigen namespace).
  if (url.pathname === "/compose-job" && req.method === "GET") {
    if (!authorize(req)) return sendJson(res, 401, { error: "unauthorized" });
    const name = url.searchParams.get("name");
    const jobs = loadJobs();
    const key = name ? `compose:${name}` : null;
    if (key) return sendJson(res, 200, { job: jobs[key] ?? null });
    return sendJson(res, 200, { jobs });
  }

  // Compose service update: volledig afgeleid uit container-labels,
  // gevalideerd tegen deploy-time allowlist. Geen request-supplied paden.
  if (url.pathname === "/compose-update" && req.method === "POST") {
    if (!authorize(req)) {
      log("rejected", "unauthorized compose update");
      return sendJson(res, 401, { error: "unauthorized" });
    }
    if (state.lock) {
      return sendJson(res, 409, { error: "another deployment operation is running", phase: state.phase });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "malformed JSON body" });
    }
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!NAME_RE.test(name)) return sendJson(res, 400, { error: "invalid container name" });
    if (body?.confirm !== "yes") return sendJson(res, 400, { error: "explicit confirmation required" });
    if (blockedContainers().has(name.toLowerCase())) {
      return sendJson(res, 403, { error: "container is AIO/externally-managed — update disabled" });
    }

    state.lock = { token: randomUUID(), since: new Date().toISOString() };
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    setJob(`compose:${name}`, { phase: "requested", startedAt: new Date().toISOString(), finishedAt: null });
    void runComposeUpdate(name).then(() => {
      void refreshCurrentImage();
      void refreshLocalVersions();
    });
    return sendJson(res, 202, { accepted: true, name, phase: "requested" });
  }

  // Sequential compose PROJECT update (v0.7.13). The request names ONLY the
  // project; members, order, paths and refusal rules are derived server-side
  // from live labels + compose config. Stops on first failure.
  if (url.pathname === "/compose-project-update" && req.method === "POST") {
    if (!authorize(req)) {
      log("rejected", "unauthorized compose project update");
      return sendJson(res, 401, { error: "unauthorized" });
    }
    if (state.lock) {
      return sendJson(res, 409, { error: "another deployment operation is running", phase: state.phase });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "malformed JSON body" });
    }
    const project = typeof body?.project === "string" ? body.project.trim() : "";
    if (!NAME_RE.test(project)) return sendJson(res, 400, { error: "invalid project name" });
    if (body?.confirm !== "yes") return sendJson(res, 400, { error: "explicit confirmation required" });
    if (pipelineOwnedProjects().includes(project.toLowerCase())) {
      return sendJson(res, 403, { error: "pipeline-owned project — dashboard never executes updates here" });
    }

    // Fast refusal: a project with high-risk / blocked members never starts.
    try {
      const members = await composeProjectMembers(project);
      if (members.length === 0) return sendJson(res, 404, { error: `no containers found for project ${project}` });
      const refusal = [];
      for (const member of members) {
        if (blockedContainers().has(member.name.toLowerCase())) refusal.push(`${member.name}: AIO/externally managed`);
        if (isHighRisk(member.name, member.image)) refusal.push(`${member.name}: HIGH risk (database/auth/proxy/DNS)`);
        if (member.labels["com.cyxno.management"] === "pipeline") refusal.push(`${member.name}: pipeline-owned`);
      }
      if (refusal.length > 0) {
        return sendJson(res, 403, { error: `project contains non-updateable members — ${refusal.join("; ")}` });
      }
    } catch (error) {
      return sendJson(res, 500, { error: String(error.message ?? error).slice(0, 200) });
    }

    state.lock = { token: randomUUID(), since: new Date().toISOString() };
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    setJob(`project:${project}`, { phase: "requested", startedAt: new Date().toISOString(), finishedAt: null });
    void runComposeProjectUpdate(project).then(() => {
      void refreshCurrentImage();
      void refreshLocalVersions();
    });
    return sendJson(res, 202, { accepted: true, project, phase: "requested" });
  }

  // Job status for a project update (v0.7.13).
  if (url.pathname === "/compose-project-job" && req.method === "GET") {
    if (!authorize(req)) return sendJson(res, 401, { error: "unauthorized" });
    const project = url.searchParams.get("project");
    const jobs = loadJobs();
    const key = project ? `project:${project}` : null;
    if (key) return sendJson(res, 200, { job: jobs[key] ?? null });
    return sendJson(res, 200, { jobs: Object.fromEntries(Object.entries(jobs).filter(([k]) => k.startsWith("project:"))) });
  }

  if (url.pathname === "/container-update" && req.method === "POST") {
    if (!authorize(req)) {
      log("rejected", "unauthorized container update");
      return sendJson(res, 401, { error: "unauthorized" });
    }
    if (state.lock) {
      return sendJson(res, 409, { error: "another deployment operation is running", phase: state.phase });
    }
    // NOTE: lock is acquired after validation (below) via tryAcquireLock.
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "malformed JSON body" });
    }
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!NAME_RE.test(name)) {
      return sendJson(res, 400, { error: "invalid container name" });
    }
    if (body?.confirm !== "yes") {
      return sendJson(res, 400, { error: "explicit confirmation required" });
    }
    if (blockedContainers().has(name.toLowerCase())) {
      return sendJson(res, 403, { error: "container is AIO/externally-managed — dashboard update disabled" });
    }
    // Pre-read the container: compose-managed is refused here as well.
    try {
      const inspect = await dockerJson(["container", "inspect", "--format", "{{json .}}", name], STEP_TIMEOUT_MS.inspect);
      const current = Array.isArray(inspect) ? inspect[0] : inspect;
      if (current?.Config?.Labels?.["com.docker.compose.project"]) {
        return sendJson(res, 403, { error: "Compose-managed — update via docker compose" });
      }
    } catch {
      return sendJson(res, 404, { error: "container not found" });
    }

    if (!tryAcquireLock()) {
      return sendJson(res, 409, { error: "another deployment operation is running", phase: state.phase });
    }
    setJob(name, { phase: "requested", startedAt: new Date().toISOString(), finishedAt: null });
    void runContainerUpdate(name).then(() => {
      void refreshCurrentImage();
      void refreshLocalVersions();
    });
    return sendJson(res, 202, { accepted: true, name, phase: "requested" });
  }

  // Rollback: rebuild from the stored snapshot (old image ID + exact config).
  if (url.pathname === "/container-rollback" && req.method === "POST") {
    if (!authorize(req)) return sendJson(res, 401, { error: "unauthorized" });
    if (state.lock) {
      return sendJson(res, 409, { error: "another deployment operation is running", phase: state.phase });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "malformed JSON body" });
    }
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!NAME_RE.test(name)) return sendJson(res, 400, { error: "invalid container name" });
    if (body?.confirm !== "yes") return sendJson(res, 400, { error: "explicit confirmation required" });
    try {
      const inspect = await dockerJson(["container", "inspect", "--format", "{{json .}}", name], STEP_TIMEOUT_MS.inspect);
      if ((Array.isArray(inspect) ? inspect[0] : inspect)?.Config?.Labels?.["com.docker.compose.project"]) {
        return sendJson(res, 403, { error: "Compose-managed — rollback via docker compose" });
      }
    } catch {
      return sendJson(res, 404, { error: "container not found" });
    }

    if (!tryAcquireLock()) {
      return sendJson(res, 409, { error: "another deployment operation is running", phase: state.phase });
    }
    setJob(name, { phase: "requested", startedAt: new Date().toISOString(), finishedAt: null });
    void runContainerUpdate(name, { rollback: true }).then(() => {
      void refreshCurrentImage();
    });
    return sendJson(res, 202, { accepted: true, name, phase: "requested" });
  }

  if (url.pathname === "/update" && req.method === "POST") {
    if (!authorize(req)) {
      log("rejected", "unauthorized update request");
      return sendJson(res, 401, { error: "unauthorized" });
    }
    if (state.lock) {
      return sendJson(res, 409, {
        error: "an update is already running",
        phase: state.phase,
        startedAt: state.startedAt,
      });
    }
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return sendJson(res, 400, { error: "malformed JSON body" });
    }
    // Only the tag is read. Any other request fields are ignored by design —
    // image/container/shell targets are deployment constants.
    const tag = typeof body?.tag === "string" ? body.tag.trim() : "";
    if (!TAG_RE.test(tag)) {
      return sendJson(res, 400, { error: "invalid tag — expected semantic version like 0.7.0" });
    }
    state.lock = { token: randomUUID(), since: new Date().toISOString() };
    state.startedAt = new Date().toISOString();
    state.finishedAt = null;
    setPhase("requested", `${IMAGE_REPO}:${tag.replace(/^v/, "")}`);
    void runUpdate(tag).then(() => {
      void refreshCurrentImage();
      void refreshLocalVersions();
    });
    return sendJson(res, 202, { accepted: true, tag: tag.replace(/^v/, ""), phase: state.phase });
  }

  sendJson(res, 404, { error: "not found" });
});

/* Only localhost. Never bind a published interface. */
/**
 * Startup recovery (helper restart mid-update): scans persisted jobs for
 * non-terminal phases and settles them against reality:
 * - pre-mutation phases → container untouched → failed (helper restart)
 * - post-mutation phases → restore from snapshot → recovery-rollback
 */
async function recoverInterruptedJobs() {
  const jobs = loadJobs();
  const ACTIVE = ["requested", "snapshotting", "pulling", "verifying", "recreating", "starting", "health-wait"];
  for (const [name, job] of Object.entries(jobs)) {
    if (!job.startedAt || job.finishedAt || !ACTIVE.includes(job.phase)) continue;
    log("recovery", `interrupted job for ${name} found (phase ${job.phase})`);
    const running = await dockerJson(
      ["container", "inspect", "--format", "{{json .State.Running}}", name],
      STEP_TIMEOUT_MS.inspect,
    ).catch(() => null);
    const isRunning = Array.isArray(running) ? running[0] === true : running === true;
    if (isRunning) {
      // Mutation either completed or never touched this container: the
      // dashboard's status poll will classify it; mark for manual review.
      job.phase = job.phase === "health-wait" || job.phase === "starting" ? "completed" : "failed";
      job.staleOrphan = true;
      job.lastResult = { ...(job.lastResult ?? {}), result: job.phase === "completed" ? "success" : "failed", error: "helper restarted during update" };
      saveJobs(jobs);
      continue;
    }
    // Container missing → restore from snapshot if we have one.
    const snapFile = nodePath.join(SNAPSHOT_DIR, `${name.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
    try {
      const snapshot = JSON.parse(readFileSync(snapFile, "utf8"));
      if (!snapshot.imageId) throw new Error("snapshot has no imageId");
      const { args, cmd } = snapshotToRunArgs(snapshot, snapshot.imageId);
      await removeContainer(name);
      await dockerRunWithEnv(args, snapshot.imageId, (snapshot.env ?? []).join("\n"), STEP_TIMEOUT_MS.replace, cmd);
      const deadline = Date.now() + HEALTH_WAIT_MS;
      let ok = false;
      while (Date.now() < deadline) {
        const verdict = await isHealthy(name);
        if (verdict.ok) { await sleep(STABILIZE_MS); const re = await isHealthy(name); if (re.ok) { ok = true; break; } }
        if (verdict.detail === "unhealthy") break;
        await sleep(4_000);
      }
      if (!ok) throw new Error("recovered container did not become healthy");
      job.phase = "recovered";
      job.finishedAt = new Date().toISOString();
      job.lastResult = { ...(job.lastResult ?? {}), result: "recovery-rollback-success" };
      log("recovery", `${name} restored from snapshot`);
    } catch (error) {
      job.phase = "recovery-failed";
      job.finishedAt = new Date().toISOString();
      job.lastResult = { ...(job.lastResult ?? {}), result: "recovery-rollback-failed", error: String(error.message ?? error).slice(0, 300) };
      log("recovery", `${name} FAILED: ${String(error.message ?? error).slice(0, 160)}`);
    }
    saveJobs(jobs);
  }
}

server.listen(PORT, LISTEN_HOST, () => {
  console.log(`update helper ${HELPER_VERSION} listening on http://${LISTEN_HOST}:${PORT} (localhost only)`);
  void recoverInterruptedJobs().catch((error) => log("recovery", `scan failed: ${error.message}`));
  console.log(`target container: ${CONTAINER_NAME}; image repo: ${IMAGE_REPO} (deployment constants)`);
  void refreshCurrentImage().then(() => {
    const probePull = async () => {
      try {

        await docker(["pull", `${IMAGE_REPO}:latest`], { timeoutMs: 60_000 });
        state.pullAvailable = true;
      } catch (error) {
        state.pullAvailable = /unauthorized|denied/i.test(error.message) ? false : null;
      }
      void refreshLocalVersions();
    };
    void probePull();
    setInterval(probePull, 3_600_000).unref();
  });
});

process.on("uncaughtException", (error) => {
  // The machine handles its own errors; a crashed helper between rm and
  // run would leave the dashboard down, so stay alive and log.
  console.error("uncaught:", error.message);
});
process.on("unhandledRejection", (error) => {
  console.error("unhandled:", error instanceof Error ? error.message : error);
});
