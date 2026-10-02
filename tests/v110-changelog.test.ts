import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

describe("v1.1.0 in-app changelog", () => {
  const markdown = read("CHANGELOG.md");

  describe("parser", () => {
    it("orders releases newest first including prereleases", async () => {
      const { parseChangelog, compareVersions } = await import("../src/lib/changelog-parser.mjs");
      const entries = parseChangelog(markdown);
      assert.equal(entries[0]?.version, "v1.2.2");
      assert.equal(entries.at(-1)?.version, "v0.9.0");
      for (let index = 0; index < entries.length - 1; index++) {
        assert.ok(
          compareVersions(entries[index]?.version ?? "", entries[index + 1]?.version ?? "") > 0,
          `${entries[index]?.version} must sort above ${entries[index + 1]?.version}`,
        );
      }
      // 1.0.0-rc1 sits between 1.0.1 and 1.0.0 (prerelease below its release).
      const versions = entries.map((entry) => entry.version);
      assert.ok(versions.indexOf("v1.0.1") < versions.indexOf("v1.0.0"), `v1.0.1 before v1.0.0, got: ${versions.join(",")}`);
      // Newest first: the RELEASE sorts above its prerelease (semver).
      assert.ok(versions.indexOf("v1.0.0") < versions.indexOf("v1.0.0-rc1"), `v1.0.0 above rc1, got: ${versions.join(",")}`);
    });

    it("rejects duplicate versions", async () => {
      const { parseChangelog } = await import("../src/lib/changelog-parser.mjs");
      assert.throws(() => parseChangelog("## v1.0.0\n### Fixed\n- a\n\n## v1.0.0\n### Fixed\n- b"), /duplicate/);
    });

    it("rejects unknown groups", async () => {
      const { parseChangelog } = await import("../src/lib/changelog-parser.mjs");
      assert.throws(() => parseChangelog("## v1.0.0\n### Gizmos\n- a"), /unknown changelog group/);
    });

    it("generates stable deep-link anchors (dots → dashes)", async () => {
      const { versionAnchor } = await import("../src/lib/changelog-parser.mjs");
      assert.equal(versionAnchor("v1.0.1"), "v1-0-1");
      assert.equal(versionAnchor("1.0.0-rc1"), "v1-0-0-rc1");
    });

    it("drops empty groups", async () => {
      const { parseChangelog } = await import("../src/lib/changelog-parser.mjs");
      const entries = parseChangelog("## v1.0.0\n### Added\n- a\n");
      assert.deepEqual(entries[0]?.groups.map((group) => group.name), ["Added"]);
    });
  });

  describe("generated artifact", () => {
    const generated = JSON.parse(read("src/generated/changelog.json"));

    it("is current with CHANGELOG.md and covers the full retrospective", () => {
      const versions = generated.releases.map((release: { version: string }) => release.version);
      assert.equal(generated.latestVersion, "v1.2.2");
      assert.equal(generated.releases.length, 29);
      for (const expected of ["v1.0.1", "v1.0.0", "v1.0.0-rc1", "v0.9.16", "v0.9.12", "v0.9.9", "v0.9.0"]) {
        assert.ok(versions.includes(expected), `missing ${expected}`);
      }
    });

    it("contains the actual 1.0.1 fix wording", () => {
      const release = generated.releases.find((release: { version: string }) => release.version === "v1.0.1");
      assert.ok(release, "v1.0.1 entry missing");
      const fixed = release.groups.find((group: { name: string }) => group.name === "Fixed");
      assert.ok(fixed?.items.some((item: string) => /service worker/i.test(item)), "1.0.1 must document the service-worker fix");
    });

    it("every release has a deep-link anchor and at least one non-empty group", () => {
      for (const release of generated.releases) {
        assert.match(release.anchor, /^v\d+-\d+-\d+/);
        assert.ok(release.groups.length > 0, `${release.version} has no content`);
      }
    });
  });

  describe("page + build validation", () => {
    const page = read("src/app/changelog/page.tsx");
    const list = read("src/app/changelog/changelog-releases.tsx");

    it("page shows the running version, latest bundled notes and the up-to-date message", () => {
      assert.match(page, /getBuildInfo\(\)/);
      assert.match(page, /You&rsquo;re running the latest bundled release notes\./);
      assert.match(page, /Latest bundled release notes:/);
      assert.match(page, /CHANGELOG\.md on GitHub/);
    });

    it("list renders Installed badge, type badges, search and deep links", () => {
      assert.match(list, /Installed/);
      assert.match(list, /Release candidate/);
      assert.match(list, /Stable/);
      assert.match(list, /Filter releases/);
      assert.match(list, /scrollIntoView/);
    });

    it("screenshot exists in the curated docs set", () => {
      assert.equal(existsSync(path.join(repoRoot, "docs/screenshots/changelog.png")), true);
    });
  });

  it("docs consistency: README links the canonical changelog and the in-app page", () => {
    const readme = read("README.md");
    assert.match(readme, /\[CHANGELOG\.md\]\(CHANGELOG\.md\)/);
    assert.match(readme, /\/changelog/);
  });
});
