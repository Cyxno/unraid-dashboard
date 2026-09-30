import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

/** Extract local markdown links + image refs from a document. */
function localRefs(markdown: string, docDir: string): string[] {
  const refs: string[] = [];
  for (const match of markdown.matchAll(/\]\(([^)\s]+)\)/g)) {
    const ref: string = match[1] ?? "";
    if (ref.startsWith("http") || ref.startsWith("#")) continue;
    refs.push(path.resolve(docDir, ref.split("#")[0] ?? ""));
  }
  return refs;
}

describe("v0.9.12 documentation integrity", () => {
  it("required docs exist", () => {
    for (const file of [
      "README.md",
      "CHANGELOG.md",
      "CONTRIBUTING.md",
      "LICENSE",
      "docs/INSTALL.md",
      "docs/CONFIGURATION.md",
      "docs/UPDATING.md",
      "docs/SECURITY.md",
      "docs/ARCHITECTURE.md",
      "docs/AGENT_API.md",
      "docs/PWA.md",
      "docs/TROUBLESHOOTING.md",
      "docs/ROADMAP.md",
    ]) {
      assert.equal(existsSync(path.join(repoRoot, file)), true, `${file} missing`);
    }
  });

  it("every local link in README and docs resolves to a real file", () => {
    const docs = ["README.md", "CONTRIBUTING.md", "CHANGELOG.md", "docs/INSTALL.md", "docs/CONFIGURATION.md", "docs/UPDATING.md", "docs/SECURITY.md", "docs/ARCHITECTURE.md", "docs/TROUBLESHOOTING.md", "docs/ROADMAP.md", "docs/AGENT_API.md", "docs/PWA.md"];
    for (const doc of docs) {
      const markdown = read(doc);
      for (const ref of localRefs(markdown, path.dirname(path.join(repoRoot, doc)))) {
        assert.equal(existsSync(ref), true, `${doc} links to missing ${ref}`);
      }
    }
  });

  it("README screenshots exist and are current PNGs", () => {
    const readme = read("README.md");
    for (const match of readme.matchAll(/docs\/screenshots\/([a-z-]+\.png)/g)) {
      const shot: string = match[1] ?? "";
      assert.equal(existsSync(path.join(repoRoot, "docs/screenshots", shot)), true, `missing ${shot}`);
    }
    const shots = readdirSync(path.join(repoRoot, "docs", "screenshots"));
    assert.ok(shots.length >= 9, "curated screenshot set incomplete");
    assert.ok(shots.every((file) => file.endsWith(".png")), "screenshots must be PNG");
  });

  it("README presents Beacon (not the legacy repo name) as the product", () => {
    const readme = read("README.md");
    assert.match(readme, /^# Beacon/);
    assert.doesNotMatch(readme, /0\.8\./);
    assert.match(readme, /Capability matrix/);
    assert.match(readme, /Demo mode/);
  });

  it("changelog covers the current series", () => {
    const changelog = read("CHANGELOG.md");
    for (const version of ["v0.9.0", "v0.9.4", "v0.9.5", "v0.9.7", "v0.9.9", "v0.9.10", "v0.9.11"]) {
      assert.match(changelog, new RegExp(version));
    }
  });

  it("docs contain no credential material (hex-64 secrets, bearer tokens)", () => {
    const docs = ["README.md", "docs/INSTALL.md", "docs/CONFIGURATION.md", "docs/SECURITY.md", "docs/UPDATING.md", "docs/ARCHITECTURE.md", "docs/TROUBLESHOOTING.md", "docs/ROADMAP.md", "docs/AGENT_API.md", "docs/PWA.md", "CHANGELOG.md", "CONTRIBUTING.md"];
    for (const doc of docs) {
      const text = read(doc);
      // 64-char lowercase hex sequences (raw keys) must not appear.
      assert.doesNotMatch(text, /\b[0-9a-f]{64}\b/, `${doc} contains a 64-hex literal`);
      assert.doesNotMatch(text, /Authorization: Bearer [A-Za-z0-9]{20,}/, `${doc} contains a bearer token`);
    }
  });

  it("issue templates ask for version/browser/page and never for secrets", () => {
    const bug = read(".github/ISSUE_TEMPLATE/bug_report.md");
    for (const needle of ["Beacon version", "Unraid version", "Browser / device", "redact"]) {
      assert.match(bug, new RegExp(needle, "i"));
    }
    assert.doesNotMatch(bug, /paste your api key/i);
  });
});

describe("v0.9.12 layout flow + docker section navigation", () => {
  const dockerPage = read("src/app/docker/page.tsx");
  const page = read("src/app/page.tsx");

  it("overview uses two independent column stacks (no row-paired grids)", () => {
    assert.match(page, /aria-label="Server detail"[\s\S]*?grid items-start gap-card xl:grid-cols-2/);
    assert.match(page, /<SectionStack className="min-w-0">/);
    // The old paired sections are gone.
    assert.doesNotMatch(page, /aria-label="Resource history and storage"/);
    assert.doesNotMatch(page, /aria-label="Containers and events"/);
  });

  it("docker anchors expand, scroll, and focus in one action", () => {
    assert.match(dockerPage, /navigateToDockerSection/);
    assert.match(dockerPage, /setOpenSections\(\(current\) => \(\{ \.\.\.current, \[key\]: true \}\)\)/);
    assert.match(dockerPage, /window\.scrollTo\(\{ top: Math\.max\(0, top\), behavior: "smooth" \}\)/);
    assert.match(dockerPage, /element\.focus\(\{ preventScroll: true \}\)/);
    assert.match(dockerPage, /aria-expanded=\{key === "containers" \? undefined : Boolean\(openSections\[key\]\)\}/);
  });

  it("secondary sections stay lazy and collapsed on page entry", () => {
    assert.match(dockerPage, /useState<Record<string, boolean>>\(\{\}\)/);
    assert.match(dockerPage, /open=\{Boolean\(openSections\.updates\)\}/);
    // The sweep-triggering panel only mounts inside the controlled lazy section.
    assert.match(dockerPage, /<LazySection[\s\S]*?>\s*<DockerUpdatesPanel \/>\s*<\/LazySection>/);
  });

  it("layout harness fails on column imbalance > 400px", () => {
    const harness = read("scripts/visual-regression.mjs");
    assert.match(harness, /worstImbalance > 400/);
    assert.match(harness, /worstColumnImbalance > 400/);
  });

  it("curated screenshots come from a demo-data script, not production", () => {
    const script = read("scripts/capture-docs-screenshots.mjs");
    assert.match(script, /127\.0\.0\.1:3200/);
    assert.match(script, /docs\/screenshots/);
  });
});
