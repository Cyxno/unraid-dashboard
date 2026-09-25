import { getEnv } from "@/server/env";
import { getBuildInfo } from "@/server/version";

/**
 * Server-side image update check against GHCR. Only runs when a token
 * with read:packages is configured (GHCR_TOKEN); otherwise reports
 * "unknown" instead of failing. The token never leaves the server.
 */

export interface UpdateCheck {
  status: "up-to-date" | "available" | "unknown";
  reason?: string;
  latestTag: string | null;
  checkedAt: string;
}

interface GhcrTagsResponse {
  tags?: string[];
  errors?: unknown[];
}

const globalStore = globalThis as unknown as {
  __dashboardUpdateCheck?: { at: number; value: UpdateCheck };
};

function parseVersion(tag: string): number[] | null {
  const cleaned = tag.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(cleaned)) return null;
  return cleaned.split(".").map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < 3; index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export async function checkForUpdate(): Promise<UpdateCheck> {
  const cached = globalStore.__dashboardUpdateCheck;
  // Check at most once per hour — never hammer GitHub.
  if (cached && Date.now() - cached.at < 3_600_000) {
    return cached.value;
  }

  const checkedAt = new Date().toISOString();
  const current = getBuildInfo().version;
  const env = (() => {
    try {
      return getEnv();
    } catch {
      return null;
    }
  })();

  if (!env?.GHCR_TOKEN) {
    const value: UpdateCheck = {
      status: "unknown",
      reason: "Update check not configured (GHCR_TOKEN missing) — the package is private.",
      latestTag: null,
      checkedAt,
    };
    globalStore.__dashboardUpdateCheck = { at: Date.now(), value };
    return value;
  }

  try {
    const response = await fetch(
      `https://ghcr.io/v2/${env.GHCR_IMAGE}/tags/list`,
      {
        headers: { authorization: `Bearer ${env.GHCR_TOKEN}` },
        signal: AbortSignal.timeout(10_000),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      const value: UpdateCheck = {
        status: "unknown",
        reason: `GHCR responded with HTTP ${response.status}.`,
        latestTag: null,
        checkedAt,
      };
      globalStore.__dashboardUpdateCheck = { at: Date.now(), value };
      return value;
    }
    const body = (await response.json()) as GhcrTagsResponse;
    const semverTags = (body.tags ?? [])
      .map((tag) => ({ tag, version: parseVersion(tag) }))
      .filter((entry): entry is { tag: string; version: number[] } => entry.version !== null)
      .sort((a, b) => compareVersions(b.version, a.version));
    const latest = semverTags[0] ?? null;
    const currentVersion = parseVersion(current);
    let value: UpdateCheck;
    if (!latest || !currentVersion) {
      value = { status: "unknown", reason: "No semver tags comparable.", latestTag: latest?.tag ?? null, checkedAt };
    } else {
      const updateAvailable = compareVersions(latest.version, currentVersion) > 0;
      value = {
        status: updateAvailable ? "available" : "up-to-date",
        latestTag: latest.tag,
        checkedAt,
      };
    }
    globalStore.__dashboardUpdateCheck = { at: Date.now(), value };
    return value;
  } catch (error) {
    const value: UpdateCheck = {
      status: "unknown",
      reason: error instanceof Error ? error.message : "Update check failed.",
      latestTag: null,
      checkedAt,
    };
    globalStore.__dashboardUpdateCheck = { at: Date.now(), value };
    return value;
  }
}

/** Test hook. */
export function resetUpdateCheck(): void {
  globalStore.__dashboardUpdateCheck = undefined;
}
