#!/usr/bin/env node
// Keeps the service worker's cache version in lockstep with package.json,
// so every release drops its own caches instead of serving stale chunks.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
// CI/strict-remote builds pass APP_VERSION (from the git tag) — it wins so
// the service worker version always matches the DEPLOYED version, even when
// package.json on the tagged source was not bumped (e.g. promotion of an RC
// commit whose package.json predates the tag).
const version = `v${process.env.APP_VERSION && /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)$/ .test(process.env.APP_VERSION) ? process.env.APP_VERSION : pkg.version}`;
const swPath = new URL("../public/sw.js", import.meta.url);
const sw = readFileSync(swPath, "utf8");
if (!sw.includes("const VERSION")) {
  console.error(`sw.js at ${swPath.href} has no VERSION line (bytes=${sw.length})`);
  process.exit(1);
}
const updated = sw.replace(/const VERSION = "[^"]+";/, `const VERSION = "${version}";`);
if (updated === sw) {
  if (sw.includes(`const VERSION = "${version}";`)) {
    console.log(`sw.js cache version already ${version}`);
    process.exit(0);
  }
  console.error(`sw.js VERSION line did not match the expected pattern (bytes=${sw.length})`);
  process.exit(1);
}
writeFileSync(swPath, updated);
console.log(`sw.js cache version -> ${version}`);
