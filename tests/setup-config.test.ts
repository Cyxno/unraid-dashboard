import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Config + setup state machine regression tests (v1.3.0).
 */

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
  resetEnvCache();
});

import { resetEnvCache } from "../src/server/env";

async function isolatedConfig(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "setup-config-"));
  const previous = process.env.AUDIT_DIR;
  process.env.AUDIT_DIR = dir;
  const { resetConfigCache } = await import("../src/server/config/store");
  resetConfigCache();
  restores.push(() => {
    if (previous === undefined) delete process.env.AUDIT_DIR;
    else process.env.AUDIT_DIR = previous;
    resetConfigCache();
  });
  return dir;
}

describe("config store", () => {
  it("defaults to trusted mode with no setup completion", async () => {
    await isolatedConfig();
    const { loadConfigFresh } = await import("../src/server/config/store");
    const config = await loadConfigFresh();
    assert.equal(config.security.mode, "trusted");
    assert.equal(config.setup.completedAt, null);
    assert.equal(config.security.sessionSecret, "");
  });

  it("recovers from a corrupt config file without crashing", async () => {
    const dir = await isolatedConfig();
    await writeFile(path.join(dir, "beacon-config.json"), "{{{corrupt", "utf8");
    const { loadConfigFresh } = await import("../src/server/config/store");
    const config = await loadConfigFresh();
    assert.equal(config.schemaVersion, 1);
    assert.equal(config.security.mode, "trusted");
  });

  it("persists and reloads config atomically", async () => {
    const dir = await isolatedConfig();
    const { loadConfigFresh, saveConfig, resetConfigCache } = await import("../src/server/config/store");
    const config = await loadConfigFresh();
    config.setup.completedAt = "2026-10-03T00:00:00Z";
    config.unraid.url = "http://127.0.0.1:442";
    config.unraid.apiKey = "test-key-123";
    await saveConfig(config);
    resetConfigCache();
    const reloaded = await loadConfigFresh();
    assert.equal(reloaded.setup.completedAt, "2026-10-03T00:00:00Z");
    assert.equal(reloaded.unraid.apiKey, "test-key-123");
    assert.ok(await readFile(path.join(dir, "beacon-config.json"), "utf8"));
  });
});

describe("setup state detection", () => {
  it("env-configured install is 'configured' without wizard", async () => {
    await isolatedConfig();
    const { setupState } = await import("../src/server/config/runtime");
    assert.equal(await setupState(), "configured", "env-provided connection means configured");
  });

  it("fresh install (no env, no config) is 'unconfigured'", async () => {
    const _dir = await isolatedConfig();
    const previousUrl = process.env.UNRAID_URL;
    const previousKey = process.env.UNRAID_API_KEY;
    delete process.env.UNRAID_URL;
    delete process.env.UNRAID_API_KEY;
    resetEnvCache();
    restores.push(() => {
      if (previousUrl !== undefined) process.env.UNRAID_URL = previousUrl;
      if (previousKey !== undefined) process.env.UNRAID_API_KEY = previousKey;
    });
    const { setupState } = await import("../src/server/config/runtime");
    assert.equal(await setupState(), "unconfigured");
  });
});
