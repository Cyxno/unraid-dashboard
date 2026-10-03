import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Security-posture regressions from the v1.2.2 external audit.
 * Each test locks a real invariant found during the review.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(path.join(repoRoot, p), "utf8");

describe("security posture (v1.2.2 audit)", () => {
  it("notification subscription removal uses the DELETE guard (not POST-only)", () => {
    // Regression: guardWrite on a DELETE handler rejected every
    // unsubscribe with 405 — devices could never unbind via the API.
    const src = read("src/app/api/notifications/subscriptions/route.ts");
    assert.match(src, /export async function DELETE/);
    assert.doesNotMatch(
      src,
      /export async function DELETE[\s\S]{0,400}?guardWrite\(request\)/,
      "DELETE handlers must not use the POST-only guardWrite",
    );
    assert.match(src, /guardDelete\(request\)/);
  });

  it("notification preferences writes are rate limited", () => {
    const src = read("src/app/api/notifications/preferences/route.ts");
    assert.match(src, /checkWriteRate\(/);
  });

  it("every notification API route is guarded (read or write)", async () => {
    const { readdir } = await import("node:fs/promises");
    const base = "src/app/api/notifications";
    for (const entry of await readdir(base, { recursive: true })) {
      const file = String(entry);
      if (!file.endsWith("route.ts")) continue;
      const src = read(path.join(base, file));
      const guarded = /guard(Read|Write|Delete)\(request\)/.test(src);
      assert.ok(guarded, `${file} must call a guard`);
    }
  });

  it("security headers include HSTS and frame-ancestors none", () => {
    const cfg = read("next.config.ts");
    assert.match(cfg, /Strict-Transport-Security/);
    assert.match(cfg, /frame-ancestors 'none'/);
    assert.match(cfg, /X-Frame-Options.*DENY/);
    assert.match(cfg, /Permissions-Policy/);
  });

  it("no shell composition in server code (spawn uses argv arrays)", () => {
    for (const file of [
      "src/server/notifications/push.ts",
      "src/server/update/helper-client.ts",
    ]) {
      const src = read(file);
      assert.doesNotMatch(src, /shell:\s*true/, `${file}: no shell:true`);
    }
    const helper = read("helper/server.js");
    assert.doesNotMatch(helper, /shell:\s*true/, "helper never spawns a shell");
    assert.match(helper, /execFile|spawn\(/);
  });

  it("subscription endpoints cap payload size", () => {
    const src = read("src/app/api/notifications/subscriptions/route.ts");
    assert.match(src, /16 \* 1024/, "oversized subscription bodies must be rejected");
  });

  it("log file reads are allowlisted against the Unraid API file list", () => {
    const service = read("src/server/unraid/service.ts");
    assert.match(service, /getLogFiles\(\)/);
    assert.match(service, /Path is not in the log file list/);
  });
});
