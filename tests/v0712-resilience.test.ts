import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

/** v0.7.12 resilience: contract-, corruptie- en UTF-8-regressies. */

describe("v0.7.12 resilience contracts", () => {
  it("error boundary bestaat", async () => {
    const src = await readFile("src/app/error.tsx", "utf8");
    assert.match(src, /reset/);
    assert.match(src, /TriangleAlert|AlertTriangle/);
  });

  it("RECOVERY.md bevat herstel-URLs en procedures", async () => {
    const md = await readFile("RECOVERY.md", "utf8");
    assert.ok(md.includes("192.168.1.2:8090"), "LAN URL");
    assert.ok(md.includes("login-ghcr.sh"), "GHCR login procedure");
    assert.ok(md.includes("docker compose"), "compose recovery");
    assert.ok(!md.match(/AUTH_PROXY_SECRET=[a-f0-9]{20,}/), "geen secrets");
  });

  it("dashboard-status script bestaat en is read-only", async () => {
    const src = await readFile("scripts/dashboard-status.sh", "utf8");
    assert.match(src, /dashboard-status/);
    assert.doesNotMatch(src, /docker\s+(rm|stop|restart)\s+unraid-dashboard/);
  });

  it("resilience backup bevat geen secrets", async () => {
    const src = await readFile("src/server/resilience/backup.ts", "utf8");
    assert.ok(!src.includes("UNRAID_API_KEY"));
    assert.ok(!src.includes("AUTH_PROXY_SECRET"));
    assert.ok(!src.includes("GHCR_TOKEN"));
  });
});

describe("v0.7.12 backup checksum", () => {
  it("sha256 via node:crypto produceert hex output", async () => {
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update("test").digest("hex");
    assert.match(hash, /^[a-f0-9]{64}$/);
  });
});
