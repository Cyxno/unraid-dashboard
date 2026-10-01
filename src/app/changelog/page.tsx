import { PageHeader } from "@/components/dashboard/page-primitives";
import { getBuildInfo } from "@/server/version";
import { ChangelogReleases } from "@/app/changelog/changelog-releases";
import { compareVersions } from "@/lib/changelog-parser.mjs";
import changelog from "@/generated/changelog.json";

export const metadata = {
  title: "Changelog",
  description: "What's changed in Beacon",
};

/**
 * Changelog / Release History (v1.1.0): renders the build-time generated
 * artifact of the canonical CHANGELOG.md — no runtime filesystem access,
 * no remote GitHub lookup, works offline in the installed PWA.
 */
export default function ChangelogPage() {
  const build = getBuildInfo();
  const running = build.version;
  const latest = changelog.latestVersion;
  const onLatest =
    running != null &&
    latest != null &&
    compareVersions(running.replace(/^v/, ""), latest.replace(/^v/, "")) >= 0;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title="Changelog" description="What's changed in Beacon" />

      <div className="mb-4 rounded-lg border bg-card p-4 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">Running: {running}</span>
          {onLatest ? (
            <span className="text-xs text-success">
              You&rsquo;re running the latest bundled release notes.
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              Latest bundled release notes: {latest}
            </span>
          )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          The full history also lives in{" "}
          <a
            href="https://github.com/Cyxno/unraid-dashboard/blob/main/CHANGELOG.md"
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            CHANGELOG.md on GitHub
          </a>
          .
        </p>
      </div>

      <ChangelogReleases releases={changelog.releases} runningVersion={running} />
    </div>
  );
}
