import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Static safety assertions for the service worker and manifest (§52).
 * The SW is plain JS served from /public; its security-relevant
 * properties are enforced here so a refactor cannot silently break
 * them: API responses are never cached, writes are never intercepted,
 * and activation is user-controlled.
 */

let swSource = "";
let manifestSource = "";

before(async () => {
  const root = path.join(import.meta.dirname ?? "tests", "..");
  swSource = await readFile(path.join(root, "public", "sw.js"), "utf8");
  manifestSource = await readFile(path.join(root, "public", "manifest.webmanifest"), "utf8");
});

describe("v06 service worker safety", () => {
  it("never caches API responses", () => {
    assert.match(swSource, /pathname\.startsWith\("\/api\/"\)\s*\)\s*return;/);
    // No cache.put may appear inside any /api branch: the only early
    // return for /api must precede every cache.put call site.
    const apiReturnIndex = swSource.indexOf('pathname.startsWith("/api/")');
    const firstPutIndex = swSource.indexOf("cache.put(");
    assert.ok(apiReturnIndex >= 0 && firstPutIndex > apiReturnIndex);
  });

  it("intercepts GET only — POSTs/actions pass through untouched", () => {
    assert.match(swSource, /request\.method !== "GET"\s*\)\s*return;/);
    assert.ok(!swSource.includes("method: 'POST'"));
    assert.ok(!swSource.includes("method: \"POST\""));
  });

  it("serves an offline navigation fallback from the cached shell", () => {
    assert.match(swSource, /request\.mode === "navigate"/);
    assert.match(swSource, /cache\.match\("\/"\)/);
  });

  it("activates a waiting worker only on explicit SKIP_WAITING", () => {
    assert.match(swSource, /"SKIP_WAITING"/);
    assert.match(swSource, /self\.skipWaiting\(\)/);
    // install must NOT call skipWaiting (no forced activation).
    const installBlock = swSource.slice(
      swSource.indexOf('addEventListener("install"'),
      swSource.indexOf('addEventListener("activate"'),
    );
    assert.ok(!installBlock.includes("skipWaiting"));
  });

  it("bounds the runtime cache", () => {
    assert.match(swSource, /trimCache\(STATIC_CACHE, \d+\)/);
  });

  it("ignores cross-origin requests", () => {
    assert.match(swSource, /url\.origin !== self\.location\.origin\)\s*return;/);
  });
});

describe("v06 web app manifest", () => {
  it("is valid JSON with the required PWA fields", () => {
    const manifest = JSON.parse(manifestSource) as Record<string, unknown>;
    assert.equal(manifest.name, "Unraid Dashboard");
    assert.equal(manifest.short_name, "Unraid");
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.scope, "/");
    assert.ok(String(manifest.theme_color).match(/^#[0-9a-f]{6}$/i));
    assert.ok(String(manifest.background_color).match(/^#[0-9a-f]{6}$/i));
  });

  it("ships any + maskable icons in required sizes", () => {
    const manifest = JSON.parse(manifestSource) as {
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
    };
    const sizes = manifest.icons.map((icon) => icon.sizes);
    assert.ok(sizes.includes("192x192"));
    assert.ok(sizes.includes("512x512"));
    assert.ok(manifest.icons.some((icon) => icon.purpose === "maskable"));
    for (const icon of manifest.icons) {
      assert.match(icon.src, /^\//); // bundled locally, no CDN
    }
  });
});
