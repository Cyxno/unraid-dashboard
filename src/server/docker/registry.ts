import { parseImageRef } from "./model";

/**
 * Registry digest checks (Phase D) — HEAD the tag's manifest and return
 * the index digest. Multi-arch correct: Docker-Content-Digest on a
 * manifest-list HEAD is the index digest, exactly what a container's
 * RepoDigests record after a pull. Read-only: a check NEVER pulls.
 * Anonymous pull tokens where the registry allows; private repos degrade
 * to AUTH_REQUIRED instead of erroring. Comparison happens in the caller
 * (compareDigests in model.ts).
 */

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const REQUEST_TIMEOUT_MS = 10_000;

export type RegistryCheckResult =
  | { kind: "digest"; remoteDigest: string }
  | { kind: "pinned"; remoteDigest: string }
  | { kind: "auth_required"; reason: string }
  | { kind: "failed"; reason: string };

async function checkV2(
  registryHost: string,
  repo: string,
  tag: string,
  authHeader?: string,
): Promise<{ status: number; digest: string | null }> {
  const response = await fetch(
    `https://${registryHost}/v2/${repo}/manifests/${tag}`,
    {
      method: "HEAD",
      headers: {
        accept: MANIFEST_ACCEPT,
        ...(authHeader ? { authorization: authHeader } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: "follow",
      cache: "no-store",
    },
  );
  return { status: response.status, digest: response.headers.get("docker-content-digest") };
}

/** Anonymous pull token for Docker Hub (works for public repos). */
async function dockerHubToken(repo: string): Promise<string | null> {
  try {
    const url = `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`;
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: string };
    return body.token ? `Bearer ${body.token}` : null;
  } catch {
    return null;
  }
}

/** Registry-agnostic remote digest check for one image reference. */
export async function checkRemoteDigest(image: string, ghcrToken?: string): Promise<RegistryCheckResult> {
  const { registry, repo, tag, digestPin } = parseImageRef(image);
  if (digestPin) {
    // Digest-pinned: the running image cannot drift from its pin.
    return { kind: "pinned", remoteDigest: digestPin };
  }

  try {
    if (registry === "docker.io") {
      const token = await dockerHubToken(repo);
      const check = await checkV2("registry-1.docker.io", repo, tag, token ?? undefined);
      if (check.status === 401) {
        return { kind: "auth_required", reason: "Docker Hub requires auth for this repository." };
      }
      if (check.status !== 200) {
        return { kind: "failed", reason: `Docker Hub responded ${check.status}.` };
      }
      return check.digest
        ? { kind: "digest", remoteDigest: check.digest }
        : { kind: "failed", reason: "no digest header" };
    }

    // Generic v2 registries (ghcr.io, lscr.io, quay.io, gcr.io, ...).
    const authHeader =
      registry === "ghcr.io" && ghcrToken ? `Bearer ${ghcrToken}` : undefined;
    const check = await checkV2(registry, repo, tag, authHeader);
    if ((check.status === 401 || check.status === 403) && registry === "ghcr.io" && !ghcrToken) {
      return {
        kind: "auth_required",
        reason: "Private GHCR package — set GHCR_TOKEN (read:packages) or run login-ghcr.sh.",
      };
    }
    if (check.status !== 200) {
      return { kind: "failed", reason: `${registry} responded ${check.status}.` };
    }
    return check.digest
      ? { kind: "digest", remoteDigest: check.digest }
      : { kind: "failed", reason: "no digest header" };
  } catch (error) {
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message.slice(0, 140) : "registry unreachable",
    };
  }
}
