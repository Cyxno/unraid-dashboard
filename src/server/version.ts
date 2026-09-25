/**
 * Runtime build provenance. Values are injected at Docker build time
 * via ARG/ENV (see Dockerfile and .github/workflows/docker-publish.yml)
 * and fall back to the package version baked in at build time by
 * next.config.ts. Only these values are ever exposed — never other
 * env content.
 */

export interface BuildInfo {
  /** App version, e.g. "0.3.0". */
  version: string;
  /** Git commit SHA the image was built from (short), if provided. */
  gitSha: string | null;
  /** ISO build timestamp, if provided by the build. */
  buildTime: string | null;
  /** OCI image ref the process is believed to run as, if provided. */
  imageRef: string | null;
}

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;
  cached = {
    version: process.env.APP_VERSION || process.env.APP_VERSION_FALLBACK || "unknown",
    gitSha: process.env.GIT_SHA || null,
    buildTime: process.env.BUILD_TIME || null,
    imageRef: process.env.IMAGE_REF || null,
  };
  return cached;
}

/** Test hook: clears the memo so env changes are picked up. */
export function resetBuildInfoCache(): void {
  cached = null;
}
