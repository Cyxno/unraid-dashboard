#!/usr/bin/env node
// Keeps the service worker's cache version in lockstep with package.json,
// so every release drops its own caches instead of serving stale chunks.
import { readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = `v${pkg.version}`;
let sw = readFileSync("public/sw.js", "utf8");
const updated = sw.replace(/const VERSION = "[^"]+";/, `const VERSION = "${version}";`);
if (updated === sw) {
  console.error("sw.js VERSION line not found — check public/sw.js");
  process.exit(1);
}
if (updated !== sw) {
  writeFileSync("public/sw.js", updated);
  console.log(`sw.js cache version -> ${version}`);
}
