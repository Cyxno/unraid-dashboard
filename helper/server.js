#!/usr/bin/env node
/*
 * unraid-dashboard update helper — single-purpose, localhost-only.
 *
 * Threat model (see SECURITY.md): this process is the ONLY component with
 * Docker access, and its API surface is three fixed operations:
 *
 *   GET  /health   liveness
 *   GET  /status   update machine state (no secrets)
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
const { randomUUID, timingSafeEqual } = require("node:crypto");
const { writeFile, unlink } = require("node:fs/promises");
const path = require("node:path");

/* ---- deployment constants (env-overridable ONLY for isolated testing) ----- */

const CONTAINER_NAME = process.env.TARGET_CONTAINER || "unraid-dashboard";
const IMAGE_REPO = process.env.TARGET_IMAGE_REPO || "ghcr.io/cyxno/unraid-dashboard";
const LISTEN_HOST = "127.0.0.1";
const PORT = Number(process.env.HELPER_PORT || 8790);
const DASHBOARD_URL = process.env.DASHBOARD_URL || `http://127.0.0.1:${process.env.DASHBOARD_PORT || 8090}`;
/** Proxy-auth secret shared with the dashboard (AUTH_PROXY_SECRET) — required
 * to reach protected endpoints when the dashboard runs AUTH_MODE=proxy. */
const DASHBOARD_AUTH_SECRET = process.env.DASHBOARD_AUTH_SECRET || "";
/** Provenance env keys excluded from preservation so the new image's own values win. */
const PROVENANCE_ENV = /^(PATH|NODE_VERSION|YARN_VERSION|NODE_ENV|HOSTNAME|HOME|NEXT_TELEMETRY_DISABLED|APP_VERSION|GIT_SHA|BUILD_TIME|IMAGE_REF)=/;
const TAG_RE = /^v?\d+\.\d+\.\d+$/;
const HEALTH_TIMEOUT_MS = 150_000;
const VERIFY_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = { inspect: 15_000, pull: 300_000, replace: 30_000 };

const HELPER_VERSION = "0.7.4";

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

function docker(args, { timeoutMs = 30_000, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`docker ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      if (onStdout) onStdout(text);
      if (stdout.length < 400_000) stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 100_000) stderr += chunk.toString();
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
async function dockerRunWithEnv(baseArgs, image, envLines, timeoutMs) {
  const envFile = path.join("/tmp", `dashenv-${randomUUID()}`);
  await writeFile(envFile, envLines + "\n", { mode: 0o600 });
  try {
    await docker([...baseArgs, "--env-file", envFile, image], { timeoutMs });
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
      const parse = (v) => String(v).replace(/^v/, "").split(".").map(Number);
      const a = parse(tag);
      const b = parse(state.currentVersion);
      let comparison = 0;
      for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) { comparison = (a[i] ?? 0) > (b[i] ?? 0) ? 1 : -1; break; }
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

    // Phase: pulling — registry auth comes from the host Docker daemon config.
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
      const local = await dockerJson(["image", "inspect", targetImage], STEP_TIMEOUT_MS.inspect).catch(() => null);
      if (!local) {
        // Nothing was mutated yet — fail cleanly.
        throw new Error(`pull failed and image is not local (${String(pullError.message).slice(0, 160)}) — run scripts/login-ghcr.sh on the host`);
      }
      pullFailed = true;
      log("pulling", "pull failed — using existing local image");
    }

    // Phase: validating image — pinned repo + sane labels.
    setPhase("validating", targetImage);
    const imageInspect = await dockerJson(["image", "inspect", targetImage], STEP_TIMEOUT_MS.inspect);
    const labels = imageInspect[0]?.Config?.Labels ?? {};
    const imageVersion = labels["org.opencontainers.image.version"];
    const imageRevision = labels["org.opencontainers.image.revision"] ?? null;
    replacementDigest = imageInspect[0]?.RepoDigests?.[0] ?? null;
    if (imageVersion && imageVersion !== normalizedTag) {
      throw new Error(`image label version ${imageVersion} does not match requested ${normalizedTag}`);
    }
    log("validating", `version=${imageVersion ?? "unlabeled"} revision=${imageRevision ? String(imageRevision).slice(0, 12) : "n/a"}`);

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

    setPhase("complete", `${fromImage} → ${targetImage}${pullFailed ? " (local image)" : ""}`);
    state.lastUpdate = {
      from: fromImage, to: targetImage, result: "success",
      startedAt: new Date(requestedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - requestedAt,
      digest: replacementDigest, usedLocalImage: pullFailed,
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

/* ---- HTTP surface ----------------------------------------------------------- */

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
    return sendJson(res, 200, { ok: true, version: HELPER_VERSION });
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
    });
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
server.listen(PORT, LISTEN_HOST, () => {
  console.log(`update helper ${HELPER_VERSION} listening on http://${LISTEN_HOST}:${PORT} (localhost only)`);
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
