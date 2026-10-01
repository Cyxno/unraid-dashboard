#!/usr/bin/env node
// Build-time changelog generation (v1.1.0):
//   CHANGELOG.md (canonical) → src/generated/changelog.json
// The /changelog page imports the generated module — no runtime filesystem
// access, deterministic, PWA-friendly, same source as GitHub.
//
// Runs in the prebuild chain; `--check` mode fails when the generated file
// is stale relative to CHANGELOG.md.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseChangelog, compareVersions } from "../src/lib/changelog-parser.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const entries = parseChangelog(source);

// Sanitary ordering check: strictly descending (semver, newest first).
for (let index = 0; index < entries.length - 1; index++) {
  const current = entries[index];
  const next = entries[index + 1];
  if (compareVersions(next.version, current.version) >= 0) {
    console.error(`changelog order violation: ${next.version} must sort below ${current.version}`);
    process.exit(1);
  }
}

const payload = {
  generatedFrom: "CHANGELOG.md",
  latestVersion: entries[0]?.version ?? null,
  releases: entries,
};

const outFile = path.join(root, "src", "generated", "changelog.json");
mkdirSync(path.dirname(outFile), { recursive: true });
const serialized = `${JSON.stringify(payload, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const existing = existsSyncSafe(outFile);
  if (existing !== serialized) {
    console.error("generated changelog is stale — run `node scripts/generate-changelog.mjs`");
    process.exit(1);
  }
  console.log("generated changelog is up to date");
} else {
  writeFileSync(outFile, serialized);
  console.log(`wrote src/generated/changelog.json (${entries.length} releases, latest ${payload.latestVersion})`);
}

function existsSyncSafe(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
