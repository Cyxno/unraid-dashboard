import assert from "node:assert/strict";
import { describe, it, beforeEach, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "test-key";

import {
  canMutate,
  canView,
  createDashboard,
  deleteDashboard,
  forkDashboard,
  getDashboard,
  importDashboards,
  listDashboards,
  updateDashboard,
} from "../src/server/dashboards/store";
import { resetEnvCache } from "../src/server/env";

let dataDir: string;
beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "dash-perm-test-"));
  process.env.DASHBOARDS_DIR = dataDir;
  resetEnvCache();
});
after(async () => {
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

const alice = { mode: "proxy" as const, user: "alice" };
const bob = { mode: "proxy" as const, user: "bob" };
const carol = { mode: "proxy" as const, user: "carol" };
const lan = { mode: "disabled" as const, user: null };

/** v0.7.3 permission model: private / shared-readonly / shared-editable. */
describe("v0.7.3 dashboard permissions — server enforcement", () => {
  it("owner can always edit; others cannot on shared-readonly (default)", async () => {
    const board = await createDashboard({ name: "Alice readonly" }, alice);
    assert.equal(canMutate(board, alice), true);
    assert.equal(canMutate(board, bob), false);
    await assert.rejects(() => updateDashboard(board.id, { name: "Bob edit" }, bob), (error: unknown) =>
      error instanceof Error && (error as { status?: number }).status === 403,
    );
    await assert.rejects(() => deleteDashboard(board.id, bob), (error: unknown) =>
      error instanceof Error && (error as { status?: number }).status === 403,
    );
  });

  it("shared-editable with empty editors lets any authenticated user edit", async () => {
    const board = await createDashboard(
      { name: "Open board", access: { mode: "shared-editable", editors: [], viewers: [] } },
      alice,
    );
    assert.equal(canMutate(board, bob), true);
    const updated = await updateDashboard(board.id, { name: "Bob edited it", access: board.access }, bob);
    assert.equal(updated.name, "Bob edited it");
  });

  it("shared-editable with an editors list only lets listed users edit", async () => {
    const board = await createDashboard(
      { name: "Team board", access: { mode: "shared-editable", editors: ["bob"], viewers: [] } },
      alice,
    );
    assert.equal(canMutate(board, bob), true);
    assert.equal(canMutate(board, carol), false);
    await assert.rejects(() => updateDashboard(board.id, { name: "Carol sneaks in" }, carol), (error: unknown) =>
      error instanceof Error && (error as { status?: number }).status === 403,
    );
  });

  it("private dashboards are hidden from unrelated users (list + get + fork read as 404)", async () => {
    const board = await createDashboard(
      { name: "Alice private", access: { mode: "private", editors: [], viewers: [] } },
      alice,
    );
    assert.equal(canView(board, alice), true);
    assert.equal(canView(board, bob), false);
    const forBob = await listDashboards(bob);
    assert.ok(!forBob.dashboards.some((entry) => entry.id === board.id));
    const forAlice = await listDashboards(alice);
    assert.ok(forAlice.dashboards.some((entry) => entry.id === board.id));
  });

  it("private dashboard viewers list grants view but not edit", async () => {
    const board = await createDashboard(
      { name: "Alice visible to bob", access: { mode: "private", editors: [], viewers: ["bob"] } },
      alice,
    );
    assert.equal(canView(board, bob), true);
    assert.equal(canMutate(board, bob), false);
  });

  it("fork copies layout into a new owner-owned dashboard without touching the source", async () => {
    const source = await createDashboard(
      { name: "Original", widgets: [{ id: "cpu", size: "lg" }] },
      alice,
    );
    const fork = await forkDashboard(source.id, bob);
    assert.equal(fork.owner, "bob");
    assert.equal(fork.widgets[0]?.id, "cpu");
    assert.equal(fork.widgets[0]?.size, "lg");
    assert.match(fork.name, /Original \(fork\)/);
    // Fork has fresh default access owned by bob.
    assert.equal(fork.access.mode, "shared-readonly");
    const untouched = await getDashboard(source.id);
    assert.equal(untouched?.name, "Original");
    assert.equal(untouched?.owner, "alice");
  });

  it("fork of a private dashboard from an unauthorized user reads as not-found", async () => {
    const board = await createDashboard(
      { name: "Secret", access: { mode: "private", editors: [], viewers: [] } },
      alice,
    );
    await assert.rejects(() => forkDashboard(board.id, bob), (error: unknown) =>
      error instanceof Error && (error as { status?: number }).status === 404,
    );
  });

  it("trusted-LAN mode retains the shared-resource behavior across all modes", async () => {
    const board = await createDashboard(
      { name: "LAN private-ish", access: { mode: "private", editors: [], viewers: [] } },
      lan,
    );
    // In trusted-LAN mode network position — not identity — is the boundary.
    assert.equal(canMutate(board, lan), true);
    assert.equal(canView(board, lan), true);
  });

  it("import carries access through; strict schema strips unknown access fields", async () => {
    const result = await importDashboards(
      {
        dashboards: [
          {
            name: "Imported private",
            access: { mode: "private", viewers: ["bob"], evil: true },
          },
        ],
      },
      alice,
    );
    assert.equal(result.imported.length, 1);
    const imported = result.imported[0]!;
    assert.equal(imported.access.mode, "private");
    assert.deepEqual(imported.access.viewers, ["bob"]);
    assert.equal("evil" in imported.access, false);
  });

  it("never persists permission lists with invalid identities (bounded, trimmed)", async () => {
    await assert.rejects(
      () =>
        createDashboard(
          { name: "Bad", access: { mode: "shared-editable", editors: ["  "], viewers: [] } },
          alice,
        ),
      (error: unknown) => error instanceof Error && (error as { status?: number }).status === 400,
    );
  });
});
