/**
 * Changelog parser (v1.1.0): turns the canonical CHANGELOG.md into a
 * typed, validated structure for the /changelog page. Pure JavaScript so
 * the build-time generator (plain node) and the app/tests share ONE
 * implementation.
 *
 * Expected format:
 *   ## vX.Y.Z[-pre]
 *   ### Group
 *   - item
 *
 * Groups are free-form but the UI knows: Added, Improved, Fixed, Security,
 * Developer. Entries are returned newest-first (semver ordering including
 * prereleases); duplicates are rejected.
 */

const VERSION_HEADING = /^##\s+(v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)\s*$/;
const GROUP_HEADING = /^###\s+(.+)$/;
const KNOWN_GROUPS = new Set(["Added", "Improved", "Fixed", "Security", "Developer", "Deprecated", "Removed"]);

/** Semver-aware ordering incl. prereleases: rc sorts below its release. */
/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
  const parse = (v) => {
    const clean = String(v).replace(/^v/, "");
    const [core, pre] = clean.split("-");
    return { numbers: (core ?? "0").split(".").map(Number), pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let index = 0; index < 3; index++) {
    const diff = (pa.numbers[index] ?? 0) - (pb.numbers[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (pa.pre && !pb.pre) return -1;
  if (!pa.pre && pb.pre) return 1;
  if (pa.pre && pb.pre) {
    if (pa.pre < pb.pre) return -1;
    if (pa.pre > pb.pre) return 1;
  }
  return 0;
}

/** Stable deep-link anchor: dots become dashes (/changelog#v1-0-1). */
/**
 * @param {string} version
 * @returns {string}
 */
export function versionAnchor(version) {
  return `v${String(version).replace(/^v/, "").replaceAll(".", "-")}`;
}

/**
 * @param {string} version
 * @returns {boolean}
 */
export function isPrerelease(version) {
  return String(version).includes("-");
}

/** Parse the changelog markdown. Throws on duplicates/unknown groups. */
/**
 * @typedef {{ version: string, anchor: string, prerelease: boolean, groups: Array<{ name: string, items: string[] }> }} ChangelogEntry
 */
/**
 * @param {string} markdown
 * @returns {ChangelogEntry[]}
 */
export function parseChangelog(markdown) {
  const seen = new Set();
  const entries = [];
  let current = null;
  let currentGroup = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    const versionMatch = line.match(VERSION_HEADING);
    if (versionMatch) {
      const version = versionMatch[1];
      const key = version.replace(/^v/, "");
      if (seen.has(key)) {
        throw new Error(`duplicate changelog version: ${version}`);
      }
      seen.add(key);
      current = {
        version,
        anchor: versionAnchor(version),
        prerelease: isPrerelease(version),
        groups: [],
      };
      entries.push(current);
      currentGroup = null;
      continue;
    }

    if (!current) continue;

    const groupMatch = line.match(GROUP_HEADING);
    if (groupMatch) {
      const name = groupMatch[1].trim();
      if (!KNOWN_GROUPS.has(name)) {
        throw new Error(`unknown changelog group: "${name}" (expected one of ${[...KNOWN_GROUPS].join(", ")})`);
      }
      currentGroup = { name, items: [] };
      current.groups.push(currentGroup);
      continue;
    }

    const itemMatch = line.match(/^-\s+(.+)$/);
    if (itemMatch && currentGroup) {
      currentGroup.items.push(itemMatch[1].trim());
    }
  }

  if (entries.length === 0) {
    throw new Error("changelog contains no release entries");
  }

  // Newest first (semver ordering, prereleases below their release).
  entries.sort((a, b) => compareVersions(b.version, a.version));
  // Drop empty groups (only show groups that contain entries).
  for (const entry of entries) {
    entry.groups = entry.groups.filter((group) => group.items.length > 0);
  }

  return entries;
}
