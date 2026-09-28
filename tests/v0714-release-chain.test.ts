import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import { badgeFromProvenance, buildReleaseChain, readBootMarker, shortDigest } from "../src/server/update/release-chain";
import type { UpdateHelperStatus } from "../src/server/update/helper-client";
import type { ManagedContainer } from "../src/server/docker/model";
import type { UpdateHistoryEntry } from "../src/server/update/history";
import { resetEnvCache } from "../src/server/env";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "release-chain-test-"));
  process.env.AUDIT_DIR = dataDir;
  resetEnvCache();
});
afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

function helper(overrides: Partial<UpdateHelperStatus> = {}): UpdateHelperStatus {
  return {
    configured: true,
    reachable: true,
    reason: null,
    helperVersion: "0.7.14",
    phase: "idle",
    detail: null,
    startedAt: null,
    finishedAt: null,
    log: [],
    lock: null,
    lastUpdate: null,
    currentImage: "ghcr.io/cyxno/unraid-dashboard:0.7.13",
    currentVersion: "0.7.13",
    currentRevision: "a5b4da9",
    currentImageId: "sha256:aaa",
    localVersions: ["0.7.13", "0.7.12"],
    pullAvailable: true,
    pullAuthRequired: false,
    requireRemote: true,
    ...overrides,
  };
}

function container(overrides: Partial<ManagedContainer["provenance"]> = {}): ManagedContainer {
  return {
    id: "abc",
    name: "unraid-dashboard",
    image: "ghcr.io/cyxno/unraid-dashboard:0.7.13",
    tag: "0.7.13",
    image_id: "sha256:aaa",
    current_digest: "sha256:digest-running",
    remote_digest: "sha256:digest-running",
    registry: "ghcr.io",
    management_type: "standalone",
    management_source: "registry-digest-without-owner:cyxno/unraid-dashboard",
    update_strategy: "registry_recreate",
    update_available: false,
    update_status: "UP_TO_DATE",
    risk: "LOW",
    policy: "notify",
    rollback_available: true,
    externallyManaged: false,
    ownership: { management: null, policy: null, risk: null, pipeline: { repo: null, deployer: null, sha: null, ref: null } },
    provenance: {
      state: "synced",
      image_id: "sha256:aaa",
      local_digest: "sha256:digest-running",
      registry_digest: "sha256:digest-running",
      locally_built: false,
      note: null,
      ...overrides,
    },
    rollback: { ready: true, level: "ready", snapshot_present: true, image_present: true, last_known_good: null, validated_at: null },
    autoEligible: false,
    autoEligibilityReasons: [],
    health: "healthy",
    last_checked: "2026-09-28T18:00:00Z",
    last_updated: null,
  };
}

describe("v0.7.14 provenance badge", () => {
  it("maps provenance states to release badges", () => {
    assert.equal(badgeFromProvenance("synced"), "Registry verified");
    assert.equal(badgeFromProvenance("local_build"), "Local build");
    assert.equal(badgeFromProvenance("registry_ahead"), "Registry ahead");
    assert.equal(badgeFromProvenance("unknown"), "Unknown provenance");
    assert.equal(badgeFromProvenance("auth_required"), "Unknown provenance");
    assert.equal(badgeFromProvenance("check_failed"), "Unknown provenance");
  });

  it("shortDigest truncates safely and passes null through", () => {
    assert.equal(shortDigest("sha256:43578963066bf68fd8829d4fab44d1057777c79a47ab978119708ee34ae525bd"), "sha256:43578963066b");
    assert.equal(shortDigest(null), null);
    assert.equal(shortDigest(undefined), null);
  });
});

describe("v0.7.14 release-chain verdict", () => {
  it("full chain verified: authenticated, remote pull, digest match", () => {
    const chain = buildReleaseChain({
      helper: helper({
        lastUpdate: {
          from: "ghcr.io/cyxno/unraid-dashboard:0.7.13",
          to: "ghcr.io/cyxno/unraid-dashboard:0.7.14",
          result: "success",
          startedAt: "2026-09-28T18:00:00Z",
          finishedAt: "2026-09-28T18:01:00Z",
          durationMs: 60_000,
          digest: "sha256:digest-new",
          usedLocalImage: false,
          source: "registry",
          registryDigest: "sha256:digest-new",
          digestMatch: true,
          requireRemote: true,
        },
      }),
      appContainer: container(),
      history: [],
      bootMarker: { verifiedAt: "2026-09-28T19:00:00Z", passed: true, failures: 0, warnings: 2 },
    });
    assert.equal(chain.ghcrAuthenticated, true);
    assert.equal(chain.remotePullAvailable, true);
    assert.equal(chain.requireRemote, true);
    assert.equal(chain.digestMatch, true);
    assert.equal(chain.provenanceBadge, "Registry verified");
    assert.equal(chain.lastRemotePull?.source, "registry");
    assert.equal(chain.lastRemotePull?.digestMatch, true);
    assert.equal(chain.bootPersistence.passed, true);
    assert.equal(chain.bootPersistence.verifiedAt, "2026-09-28T19:00:00Z");
  });

  it("no GHCR auth → authenticated false, badge falls back to provenance state", () => {
    const chain = buildReleaseChain({
      helper: helper({ pullAvailable: false, pullAuthRequired: true, requireRemote: false }),
      appContainer: container({ state: "local_build", locally_built: true, local_digest: null, registry_digest: null }),
      history: [],
      bootMarker: null,
    });
    assert.equal(chain.ghcrAuthenticated, false);
    assert.equal(chain.remotePullAvailable, false);
    assert.equal(chain.requireRemote, false);
    assert.equal(chain.provenanceBadge, "Local build");
    assert.equal(chain.digestMatch, null);
    assert.equal(chain.bootPersistence.passed, null);
  });

  it("offline helper degrades to null verdicts, never fabricated ones", () => {
    const chain = buildReleaseChain({
      helper: helper({ reachable: false, pullAvailable: null, pullAuthRequired: null }),
      appContainer: container(),
      history: [],
      bootMarker: null,
    });
    assert.equal(chain.ghcrAuthenticated, null);
    assert.equal(chain.remotePullAvailable, null);
    assert.equal(chain.digestMatch, true); // still comparable from inventory+registry cache
    assert.equal(chain.bootPersistence.passed, null);
  });

  it("history fallback supplies last remote pull when the helper was replaced", () => {
    const entry: UpdateHistoryEntry = {
      timestamp: "2026-09-28T18:01:00Z",
      startedAt: "2026-09-28T18:00:00Z",
      actor: "cyxno",
      fromVersion: "0.7.13",
      fromDigest: null,
      toVersion: "0.7.14",
      toDigest: "sha256:digest-new",
      durationMs: 60_000,
      phasesReached: [],
      result: "success",
      rollbackPerformed: false,
      usedLocalImage: false,
      source: "registry",
      registryDigest: "sha256:digest-new",
      digestMatch: true,
    };
    const chain = buildReleaseChain({
      helper: helper({ lastUpdate: null }),
      appContainer: container(),
      history: [entry],
      bootMarker: null,
    });
    assert.equal(chain.lastRemotePull?.to, "0.7.14");
    assert.equal(chain.lastRemotePull?.digest, "sha256:digest-new");
    assert.equal(chain.lastRemotePull?.source, "registry");
  });
});

describe("v0.7.14 boot-verification marker", () => {
  it("reads a well-formed marker", async () => {
    await writeFile(
      path.join(dataDir, "boot-verification.json"),
      JSON.stringify({ verifiedAt: "2026-09-28T19:00:00Z", passed: true, failures: 0, warnings: 2, scriptVersion: "0.7.14" }),
    );
    const marker = await readBootMarker();
    assert.equal(marker?.passed, true);
    assert.equal(marker?.warnings, 2);
  });

  it("absent or corrupt marker → null (no fabricated pass)", async () => {
    assert.equal(await readBootMarker(), null);
    await writeFile(path.join(dataDir, "boot-verification.json"), "{not json");
    assert.equal(await readBootMarker(), null);
  });

  it("marker path lives under AUDIT_DIR (persistent /app/data)", async () => {
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, "boot-verification.json"), '{"passed":false}');
    const marker = await readBootMarker();
    assert.equal(marker?.passed, false);
  });
});
