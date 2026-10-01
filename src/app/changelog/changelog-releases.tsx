"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { compareVersions, versionAnchor } from "@/lib/changelog-parser.mjs";

export interface ChangelogRelease {
  version: string;
  anchor: string;
  prerelease: boolean;
  groups: Array<{ name: string; items: string[] }>;
}

/**
 * Collapsible release list (v1.1.0): the newest 2-3 releases are expanded
 * by default, older ones collapsed. A lightweight text filter matches
 * version or changelog text. Deep links (/changelog#v1-0-1) force their
 * release open on load.
 */

const DEFAULT_OPEN_COUNT = 3;

export function ChangelogReleases({
  releases,
  runningVersion,
}: {
  releases: ChangelogRelease[];
  runningVersion: string | null;
}) {
  const [query, setQuery] = useState("");
  const [forcedOpen, setForcedOpen] = useState<string[]>([]);

  // Deep link: opening /changelog#v1-0-1 expands that release.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    const match = releases.find((release) => versionAnchor(release.version) === hash);
    if (match) {
      // One-shot deep-link expansion on mount; the sync call is the point.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- expand-on-mount for hash deep links
      setForcedOpen((current) => [...current, match.version]);
      requestAnimationFrame(() => {
        document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- releases are static build data
  }, []);

  const normalizedRunning = runningVersion?.replace(/^v/, "") ?? null;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return releases;
    return releases.filter((release) =>
      JSON.stringify(release).toLowerCase().includes(q),
    );
  }, [query, releases]);

  const isOpenByDefault = (release: ChangelogRelease) =>
    forcedOpen.includes(release.version) ||
    releases.findIndex((r) => r.version === release.version) < DEFAULT_OPEN_COUNT;

  return (
    <div>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter releases…"
        aria-label="Filter releases"
        className="mb-3 h-9 w-full max-w-sm rounded-md border bg-card px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />

      <div className="space-y-2">
        {visible.map((release) => {
          const installed =
            normalizedRunning != null &&
            compareVersions(release.version, normalizedRunning) === 0;
          return (
            <details
              key={release.version}
              id={versionAnchor(release.version)}
              open={isOpenByDefault(release)}
              className="group scroll-mt-20 rounded-lg border bg-card"
            >
              <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-3 py-2.5 text-sm font-medium">
                <span className="font-mono">{release.version.startsWith("v") ? release.version : `v${release.version}`}</span>
                {release.prerelease ? (
                  <Badge variant="warning" className="text-[10px]">
                    Release candidate
                  </Badge>
                ) : (
                  <Badge variant="muted" className="text-[10px]">
                    Stable
                  </Badge>
                )}
                {installed && (
                  <Badge variant="success" className="text-[10px]">
                    Installed
                  </Badge>
                )}
                <span className="ml-auto text-[10px] normal-case text-muted-foreground group-open:hidden">
                  details
                </span>
              </summary>
              <div className="space-y-2 px-3 pb-3 text-sm">
                {release.groups.map((group) => (
                  <div key={group.name}>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {group.name}
                    </p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
                      {group.items.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
        {visible.length === 0 && (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            No releases match the filter.
          </p>
        )}
      </div>
    </div>
  );
}
