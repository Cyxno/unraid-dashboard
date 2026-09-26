import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

// Environment must exist before any store module touches getEnv().
process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "test-key";

import {
  DASHBOARD_LIMITS,
  DASHBOARD_SCHEMA_VERSION,
  DashboardError,
  createDashboard,
  deleteDashboard,
  getDashboard,
  importDashboards,
  listDashboards,
  updateDashboard,
} from "../src/server/dashboards/store";
import { resetEnvCache } from "../src/server/env";
import { resetWriteLimit } from "../src/server/dashboards/rate-limit";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "dash-store-test-"));
  process.env.DASHBOARDS_DIR = dataDir;
  // Both caches must clear so the new dir takes effect per test.
  resetEnvCache();
  resetWriteLimit();
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

const identityProxy = { mode: "proxy" as const, user: "alice" };
const identityProxyBob = { mode: "proxy" as const, user: "bob" };
const identityLan = { mode: "disabled" as const, user: null };

const sampleInput = {
  name: "Wallboard A",
  layout: { order: ["cpu", "docker", "memory"], hidden: ["uptime"] },
  preferences: { historyWindow: "1h", density: "compact", dockerFilter: "plex" },
};

describe("v06 shared dashboard store", () => {
  it("creates, lists, reads, updates and deletes dashboards", async () => {
    const created = await createDashboard(sampleInput, identityProxy);
    assert.match(created.id, /^[a-z0-9]{12}$/);
    assert.equal(created.owner, "alice");
    assert.equal(created.schemaVersion, DASHBOARD_SCHEMA_VERSION);
    assert.equal(created.layout.order.length, 3);
    assert.equal(created.layout.hidden[0], "uptime");
    assert.equal(created.preferences.dockerFilter, "plex");

    const listed = await listDashboards();
    assert.equal(listed.dashboards.length, 1);
    assert.equal(listed.invalid.length, 0);

    const fetched = await getDashboard(created.id);
    assert.equal(fetched?.name, "Wallboard A");

    const updated = await updateDashboard(
      created.id,
      { name: "Renamed", layout: { order: ["docker"], hidden: [] }, preferences: {} },
      identityProxy,
    );
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.layout.order[0], "docker");
    // defaults applied on update
    assert.equal(updated.preferences.historyWindow, "15m");

    await deleteDashboard(created.id, identityProxy);
    const afterDelete = await getDashboard(created.id);
    assert.equal(afterDelete, null);
  });

  it("assigns owner 'lan' in trusted-LAN mode and lets LAN users mutate", async () => {
    const created = await createDashboard({ name: "LAN board" }, identityLan);
    assert.equal(created.owner, "lan");
    await updateDashboard(created.id, { name: "LAN board 2" }, identityLan);
    await deleteDashboard(created.id, identityLan);
  });

  it("enforces ownership in proxy mode", async () => {
    const created = await createDashboard({ name: "Alice's" }, identityProxy);
    await assert.rejects(
      () => updateDashboard(created.id, { name: "Hacked" }, identityProxyBob),
      (error: unknown) => error instanceof DashboardError && error.status === 403,
    );
    await assert.rejects(
      () => deleteDashboard(created.id, identityProxyBob),
      (error: unknown) => error instanceof DashboardError && error.status === 403,
    );
  });

  it("rejects malformed payloads: empty name, unknown widgets, duplicate order, bad preferences", async () => {
    await assert.rejects(
      () => createDashboard({ name: "   " }, identityProxy),
      (error: unknown) => error instanceof DashboardError && error.status === 400,
    );
    await assert.rejects(
      () => createDashboard({ name: "X", layout: { order: ["cpu", "nuclear-widget"], hidden: [] } }, identityProxy),
      (error: unknown) => error instanceof DashboardError && error.status === 400,
    );
    await assert.rejects(
      () => createDashboard({ name: "X", layout: { order: ["cpu", "cpu"], hidden: [] } }, identityProxy),
      (error: unknown) => error instanceof DashboardError && error.status === 400,
    );
    await assert.rejects(
      () => createDashboard({ name: "X", preferences: { historyWindow: "42m" } }, identityProxy),
      (error: unknown) => error instanceof DashboardError && error.status === 400,
    );
    // Hiding every widget is rejected.
    await assert.rejects(
      () => createDashboard({ name: "X", layout: { order: ["cpu"], hidden: ["cpu"] } }, identityProxy),
      (error: unknown) => error instanceof DashboardError && error.status === 400,
    );
  });

  it("strips unknown fields (strict schema)", async () => {
    const created = await createDashboard(
      {
        name: "Typed",
        layout: { order: ["cpu"], hidden: [], evilField: "nope" },
        preferences: { density: "compact", apiKey: "should-not-persist" },
      },
      identityProxy,
    );
    assert.equal("evilField" in created.layout, false);
    assert.equal("apiKey" in created.preferences, false);
  });

  it("rejects bad ids before touching the filesystem", async () => {
    await assert.rejects(
      () => getDashboard("../../etc/passwd"),
      (error: unknown) => error instanceof DashboardError && error.status === 400,
    );
    await assert.rejects(
      () => getDashboard("UPPERCASE1234"),
      (error: unknown) => error instanceof DashboardError && error.status === 400,
    );
    await assert.rejects(
      () => deleteDashboard("a".repeat(300), identityLan),
      (error: unknown) => error instanceof DashboardError && error.status === 400,
    );
  });

  it("enforces the dashboard count limit", async () => {
    for (let index = 0; index < DASHBOARD_LIMITS.maxDashboards; index++) {
      await createDashboard({ name: `Board ${index}` }, identityLan);
    }
    await assert.rejects(
      () => createDashboard({ name: "One too many" }, identityLan),
      (error: unknown) => error instanceof DashboardError && error.status === 409,
    );
  });

  it("migrates legacy/unversioned documents with a backup and stamps schemaVersion", async () => {
    // Hand-write a v0 document (missing schemaVersion, owner, preferences…).
    const legacy = {
      id: "legacyboard1",
      name: "Legacy board",
      layout: { order: ["cpu", "memory"] },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await writeFile(path.join(dataDir, "legacyboard1.json"), JSON.stringify(legacy), "utf8");
    const migrated = await getDashboard("legacyboard1");
    assert.ok(migrated);
    assert.equal(migrated.schemaVersion, DASHBOARD_SCHEMA_VERSION);
    assert.equal(migrated.preferences.historyWindow, "15m");
    // Backup of the original exists.
    const files = await readdir(dataDir);
    assert.ok(files.some((name) => name.startsWith("legacyboard1.json.bak-")));
    // Future schema versions are refused (left untouched).
    const future = { ...legacy, schemaVersion: 99, id: "futureboard1" };
    await writeFile(path.join(dataDir, "futureboard1.json"), JSON.stringify(future), "utf8");
    const refused = await getDashboard("futureboard1");
    assert.equal(refused, null);
  });

  it("import creates new ids, adopts requester ownership, rejects bad entries", async () => {
    const result = await importDashboards(
      {
        dashboards: [
          { name: "Imported A", layout: { order: ["docker"], hidden: [] } },
          { name: "", layout: {} }, // invalid name → rejected, not fatal
          { name: "Imported B", preferences: { historyWindow: "24h" } },
        ],
      },
      identityProxyBob,
    );
    assert.equal(result.imported.length, 2);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0]?.index, 1);
    assert.ok(result.imported.every((dashboard) => dashboard.owner === "bob"));
    const ids = new Set(result.imported.map((dashboard) => dashboard.id));
    assert.equal(ids.size, result.imported.length);
  });

  it("import rejects non-JSON payloads and flags entries with unknown fields", async () => {
    await assert.rejects(
      () => importDashboards("not json at all", identityLan),
      (error: unknown) => error instanceof DashboardError && error.status === 400,
    );
    const result = await importDashboards(
      { dashboards: [{ name: "x", layout: {}, evil: true }] },
      identityLan,
    );
    assert.equal(result.imported.length, 0);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]?.reason ?? "", /evil|Unrecognized/i);
  });

  it("never stores secrets: file content contains only schema fields", async () => {
    const created = await createDashboard(
      { name: "Secrets probe", layout: {}, preferences: {} },
      identityProxy,
    );
    const raw = await readFile(path.join(dataDir, `${created.id}.json`), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      assert.ok(
        ["schemaVersion", "id", "name", "owner", "layout", "preferences", "createdAt", "updatedAt"].includes(key),
        `unexpected top-level field ${key}`,
      );
    }
  });
});
