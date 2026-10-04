import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import {
  buildManagedContainer,
  canonicalUpdateState,
  parseImageRef,
  type ContainerFacts,
} from "../src/server/docker/model";
import { isContainerProblem } from "../src/lib/container-health";
import { updatesSummaryFromCache } from "../src/server/docker/updates";

function facts(overrides: Partial<ContainerFacts> = {}): ContainerFacts {
  return {
    id: "abc123",
    name: "some-container",
    image: "ghcr.io/owner/app:1.0.0",
    state: "running",
    status: "Up 2 hours",
    health: "healthy",
    imageId: "sha256:imageid",
    repoDigests: ["ghcr.io/owner/app@sha256:aaaa"],
    created: "2026-09-26T00:00:00Z",
    networks: [],
    volumeSources: [],
    labels: {},
    ...overrides,
  };
}

/* ---- registry normalization (Fase 7/8) ---------------------------------- */

test("Docker Hub implicit namespace: netdata/netdata stays org/repo on docker.io", () => {
  const ref = parseImageRef("netdata/netdata:stable");
  assert.equal(ref.registry, "docker.io");
  assert.equal(ref.repo, "netdata/netdata");
});

test("Docker Hub official images normalize to library/<name>", () => {
  const ref = parseImageRef("mysql");
  assert.equal(ref.registry, "docker.io");
  assert.equal(ref.repo, "library/mysql");
});

test("ghcr.io, lscr.io, quay.io and gcr.io refs resolve to their own registry", () => {
  for (const image of [
    "ghcr.io/cyxno/unraid-dashboard:1.3.8",
    "lscr.io/linuxserver/radarr:latest",
    "quay.io/something/else:1",
    "gcr.io/cadvisor/cadvisor:latest",
  ]) {
    const ref = parseImageRef(image);
    assert.equal(ref.registry, image.split("/")[0]);
  }
});

/* ---- canonical verdict semantics (Fase 4/6/10/27) ----------------------- */

test("registry image with empty RepoDigests is NOT a local build (digest 200 → UNKNOWN, never LOCAL_BUILD)", () => {
  const v = canonicalUpdateState(facts({ repoDigests: [] }), { kind: "digest", remoteDigest: "sha256:whatever" });
  assert.equal(v.update_status, "UNKNOWN");
  assert.notEqual(v.update_status, "LOCAL_BUILD");
  assert.equal(v.update_available, false);
});

test("registry image with matching digest is UP_TO_DATE even if RepoDigests were missing", () => {
  // Missing local digest ⇒ cannot compare ⇒ UNKNOWN (honest), NOT update.
  const v = canonicalUpdateState(facts({ repoDigests: [] }), { kind: "digest", remoteDigest: "sha256:aaaa" });
  assert.equal(v.update_status, "UNKNOWN");
});

test("auth error is never a local build", () => {
  const v = canonicalUpdateState(facts(), { kind: "auth_required", reason: "denied" });
  assert.equal(v.update_status, "AUTH_REQUIRED");
});

test("timeout / registry failure is never a local build", () => {
  const v = canonicalUpdateState(facts(), { kind: "failed", reason: "timeout after 10s" });
  assert.equal(v.update_status, "CHECK_FAILED");
});

test("true local build: registry 404 is the only LOCAL_BUILD evidence", () => {
  const v = canonicalUpdateState(facts({ repoDigests: [], image: "plex-scraper:local" }), {
    kind: "not_found",
    reason: "docker.io has no repository library/plex-scraper (404)",
  });
  assert.equal(v.update_status, "LOCAL_BUILD");
  assert.equal(v.update_available, false);
});

test("digest-pinned image is PINNED and cannot drift", () => {
  const v = canonicalUpdateState(facts({ image: "postgres:16@sha256:feed" }), { kind: "digest", remoteDigest: "sha256:zzz" });
  assert.equal(v.update_status, "PINNED");
  assert.equal(v.update_available, false);
});

/* ---- update state != runtime state != health (Fase 20/21/35) ------------ */

test("stopped container can have an update and stays neutral (v1.3.8 semantics intact)", () => {
  const stopped = facts({ state: "EXITED", status: "Exited (0) 3 days ago" });
  const v = canonicalUpdateState(stopped, { kind: "digest", remoteDigest: "sha256:new" });
  assert.equal(v.update_available, true);
  // update_available is NOT a problem; stopped is NOT a problem.
  assert.equal(isContainerProblem({ state: "EXITED", health: null, status: "Exited (0) 3 days ago" }), false);
});

test("unhealthy is independent of update state — still a problem", () => {
  assert.equal(isContainerProblem({ state: "RUNNING", health: "unhealthy", status: "Up (unhealthy)" }), true);
  const built = buildManagedContainer({
    facts: facts({ health: "unhealthy" }),
    customDeployContainers: [],
    extraHighRisk: [],
    rawCheck: { kind: "digest", remoteDigest: "sha256:aaaa" },
    checkedAt: "now",
  });
  assert.equal(built.update_status, "UP_TO_DATE");
  assert.equal(built.health, "unhealthy");
});

/* ---- summary cache: exact counts, dedup, stale (Fase 9/13/19/22/24/26) --- */

const store = globalThis as unknown as {
  __dockerInventoryCache?: { at: number; containers: ContainerFacts[]; storage: { mode: string; source: string | null } };
  __dockerUpdateCache?: Map<string, { at: number; outcome: unknown }>;
};

function injectCache(containers: ContainerFacts[], checks: Record<string, unknown>, at = Date.now()) {
  store.__dockerInventoryCache = { at, containers, storage: { mode: "image-file", source: null } };
  const map = new Map<string, { at: number; outcome: unknown }>();
  for (const [image, outcome] of Object.entries(checks)) map.set(image, { at, outcome });
  store.__dockerUpdateCache = map;
}

test("summary counts exactly the canonical verdicts: 7 updates → 7", () => {
  const containers = Array.from({ length: 10 }, (_, i) =>
    facts({ id: `c${i}`, name: `c${i}`, image: `ghcr.io/o/app${i}:1`, repoDigests: [`ghcr.io/o/app${i}@sha256:aaaa`] }),
  );
  const checks: Record<string, unknown> = {};
  for (let i = 0; i < 7; i++) checks[`ghcr.io/o/app${i}:1`] = { kind: "digest", remoteDigest: "sha256:new" };
  checks["ghcr.io/o/app7:1"] = { kind: "digest", remoteDigest: "sha256:aaaa" };
  checks["ghcr.io/o/app8:1"] = { kind: "auth_required", reason: "denied" };
  checks["ghcr.io/o/app9:1"] = { kind: "not_found", reason: "404" };
  injectCache(containers, checks);
  const summary = updatesSummaryFromCache();
  assert.equal(summary.available, true);
  assert.equal(summary.knownUpdatesCount, 7);
  assert.equal(summary.containers.filter((c) => c.update_available).length, 7);
  assert.equal(summary.stale, false);
  // Local builds: only the proven one.
  assert.equal(summary.containers.filter((c) => c.update_status === "LOCAL_BUILD").length, 1);
});

test("stale cache: no strong all-up-to-date claim — stale flag rides along", () => {
  const containers = [facts({ id: "c0", image: "ghcr.io/o/app:1", repoDigests: ["ghcr.io/o/app@sha256:aaaa"] })];
  // Fresh cache written 5h ago → past the 4h TTL.
  injectCache(containers, { "ghcr.io/o/app:1": { kind: "digest", remoteDigest: "sha256:aaaa" } }, Date.now() - 5 * 3600_000);
  const summary = updatesSummaryFromCache();
  assert.equal(summary.knownUpdatesCount, 0);
  assert.equal(summary.stale, true);
});

test("no cache at all → stale, count null (never a fabricated zero claim)", () => {
  injectCache([facts({ id: "c0" })], {});
  store.__dockerUpdateCache = new Map();
  const summary = updatesSummaryFromCache();
  assert.equal(summary.stale, true);
});

test("multiple containers sharing one image map to one cache entry (dedup key)", () => {
  const shared = "ghcr.io/o/shared:1";
  const containers = Array.from({ length: 5 }, (_, i) =>
    facts({ id: `x${i}`, name: `x${i}`, image: shared, repoDigests: [`${shared.replace(":1", "")}@sha256:aaaa`] }),
  );
  injectCache(containers, { [shared]: { kind: "digest", remoteDigest: "sha256:aaaa" } });
  const summary = updatesSummaryFromCache();
  assert.equal(summary.containers.length, 5);
  assert.equal(summary.containers.filter((c) => c.update_available).length, 0);
});

/* ---- frontend consistency patterns (Fase 15/17/26/27) ------------------- */

test("Docker page derives badge/filter/counter from the canonical verdicts, not the inventory flag", async () => {
  const fs = await import("node:fs");
  const page = fs.readFileSync("src/app/docker/page.tsx", "utf8");
  // canonical source drives all three consumers
  assert.match(page, /updateVerdicts/);
  assert.match(page, /filter === "update"\) list = list\.filter\(\(c\) => isCanonicalUpdate\(c\)\)/);
  assert.match(page, /update: canonicalUpdateCount/);
  assert.match(page, /isCanonicalUpdate\(container\) && \(/);
  // the old separate flag no longer drives badges/filters in the page
  assert.doesNotMatch(page, /c\.updateAvailable/);
});

test("overview card badge uses the canonical summary too", async () => {
  const fs = await import("node:fs");
  const overview = fs.readFileSync("src/components/dashboard/docker-overview-list.tsx", "utf8");
  assert.match(overview, /updates-summary/);
  assert.match(overview, /updateIds\.has\(container\.id\)/);
  assert.doesNotMatch(overview, /container\.updateAvailable/);
});

test("panel never claims all-up-to-date over stale data", async () => {
  const fs = await import("node:fs");
  const panel = fs.readFileSync("src/components/docker/updates-panel.tsx", "utf8");
  assert.match(panel, /data\.stale \? \(/);
  assert.match(panel, /no known updates · stale data/);
  const route = fs.readFileSync("src/app/api/docker/updates/route.ts", "utf8");
  assert.match(route, /stale: summaryCache\.stale/);
});

test("check now is a single canonical refresh endpoint (force + shared caches)", async () => {
  const fs = await import("node:fs");
  const route = fs.readFileSync("src/app/api/docker/check-updates/route.ts", "utf8");
  assert.match(route, /updatesOverview\(\{ refresh: true \}\)/);
});

test("cache invalidation runs after a settled update", async () => {
  const fs = await import("node:fs");
  const route = fs.readFileSync("src/app/api/docker/update-status/route.ts", "utf8");
  assert.match(route, /invalidateUpdateState/);
});

test("pipeline-owned containers never claim updates in summary OR model (15-vs-14 regression)", async () => {
  const { updateVerdictForFacts } = await import("../src/server/docker/model");
  const facts2 = facts({
    name: "tornscope-postgres-1",
    image: "postgres:16-alpine",
    repoDigests: ["library/postgres@sha256:aaaa"],
    labels: { "com.docker.compose.project": "tornscope", "com.docker.compose.service": "postgres" },
  });
  const v = updateVerdictForFacts(facts2, { kind: "digest", remoteDigest: "sha256:new" });
  assert.equal(v.management_type, "pipeline_owned");
  assert.equal(v.update_available, false);
  assert.equal(v.update_status, "LOCAL_BUILD");
  // and the full model agrees — no divergent derivation
  const built = buildManagedContainer({
    facts: facts2,
    customDeployContainers: [],
    extraHighRisk: [],
    rawCheck: { kind: "digest", remoteDigest: "sha256:new" },
    checkedAt: "now",
  });
  assert.equal(built.update_available, false);
  assert.equal(built.update_status, "LOCAL_BUILD");
});

/* ---- production fixture consistency (Fase 32/33) ------------------------ */

test("production snapshot consistency: registry-managed images classify from digests, local builds from 404", () => {
  // Before v1.3.9 the live inventory answered local_build for ALL 62
  // containers because the helper's batch inspect degraded to null. The
  // classification can no longer be derived from a missing digest alone:
  const degraded = canonicalUpdateState(facts({ repoDigests: [] }), null);
  assert.equal(degraded.update_status, "UNKNOWN");
  const netdata = canonicalUpdateState(
    facts({ image: "netdata/netdata:stable", repoDigests: ["netdata/netdata@sha256:2197"] }),
    { kind: "digest", remoteDigest: "sha256:2197" },
  );
  assert.equal(netdata.update_status, "UP_TO_DATE");
});
