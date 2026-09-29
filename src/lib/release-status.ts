/**
 * Release-status semantics (v0.9.2): ONE normalized model for every
 * version-related surface (PWA banner, Settings, Operations). No generic
 * "newer version available" for unrelated conditions.
 */

export type ReleaseStatusKind =
  | "none"
  | /** semver(latest) > semver(running) → real update available */
  "update-available"
  | /** server rebuilt (same or any version) but browser bundle stale → refresh UI */
  "browser-refresh"
  | /** provenance mismatch, registry auth, etc. — technical, not a banner */
  "provenance-warning";

export interface ReleaseSignal {
  kind: ReleaseStatusKind;
  /** Semver "greater" relation between server and bundle. */
  serverNewer: boolean;
}

/** Parses "v?X.Y.Z" prefix for ordering; returns null when unparseable. */
export function parseSemver(version: string | null | undefined): [number, number, number] | null {
  if (!version) return null;
  const match = version.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function semverGreater(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let index = 0; index < 3; index++) {
    if ((pa[index] ?? 0) !== (pb[index] ?? 0)) return (pa[index] ?? 0) > (pb[index] ?? 0);
  }
  return false;
}

/**
 * Decides which banner (if any) applies:
 * - server semver > bundle semver         → "update-available"
 * - versions differ (server not newer)    → "browser-refresh" (stale shell
 *   after a deploy; refreshed UI loads the current interface)
 * - equal                                 → none
 */
export function versionMismatchKind(serverVersion: string | null, bundleVersion: string | null): ReleaseStatusKind {
  if (!serverVersion || !bundleVersion || bundleVersion === "unknown") return "none";
  if (serverVersion === bundleVersion) return "none";
  // Same version with cosmetic prefix differences (v0.9.1 vs 0.9.1) is NOT
  // a mismatch — compare parsed semver for the equal case too.
  const parsedA = parseSemver(serverVersion);
  const parsedB = parseSemver(bundleVersion);
  if (parsedA && parsedB && parsedA.every((part, index) => part === parsedB[index])) return "none";
  return semverGreater(serverVersion, bundleVersion) ? "update-available" : "browser-refresh";
}
