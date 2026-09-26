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
): Promise<{ status: number; digest: string | null; wwwAuthenticate: string | null }> {
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
  return {
    status: response.status,
    digest: response.headers.get("docker-content-digest"),
    wwwAuthenticate: response.headers.get("www-authenticate"),
  };
}

/**
 * Anonymous Bearer grant against a registry's WWW-Authenticate realm —
 * works for public repos on Docker Hub, lscr.io, ghcr.io and most v2
 * registries. Returns null when the realm is unreachable or demands
 * real credentials.
 */
async function anonymousToken(realm: string, service: string | null, repo: string): Promise<string | null> {
  try {
    const url = new URL(realm);
    url.searchParams.set("scope", `repository:${repo}:pull`);
    if (service) url.searchParams.set("service", service);
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), cache: "no-store" });
    if (!response.ok) return null;
    const body = (await response.json()) as { token?: string; access_token?: string };
    const token = body.token ?? body.access_token;
    return token ? `Bearer ${token}` : null;
  } catch {
    return null;
  }
}

/** Parses a WWW-Authenticate: Bearer challenge into realm + service. */
function parseChallenge(header: string | null): { realm: string; service: string | null } | null {
  if (header === null || !header.startsWith("Bearer ")) return null;
  const realm = header.match(/realm="([^"]+)"/)?.[1] ?? null;
  const service = header.match(/service="([^"]+)"/)?.[1] ?? null;
  return realm ? { realm, service } : null;
}

/** Registry-agnostic remote digest check for one image reference. */
export async function checkRemoteDigest(image: string, ghcrToken?: string): Promise<RegistryCheckResult> {
  const { registry, repo, tag, digestPin } = parseImageRef(image);
  if (digestPin) {
    // Digest-pinned: the running image cannot drift from its pin.
    return { kind: "pinned", remoteDigest: digestPin };
  }

  // GHCR token from dashboard env takes precedence for ghcr.io.
  let authHeader: string | undefined =
    registry === "ghcr.io" && ghcrToken ? `Bearer ${ghcrToken}` : undefined;

  try {
    let check = await checkV2(registry, repo, tag, authHeader);

    // 401 challenge → try an anonymous grant against the advertised realm
    // (works for public repos on Docker Hub, lscr.io, ghcr.io, quay.io…).
    if (check.status === 401 && !authHeader) {
      const challenge = parseChallenge(check.wwwAuthenticate);
      if (challenge) {
        const granted = await anonymousToken(challenge.realm, challenge.service, repo);
        if (granted) {
          authHeader = granted;
          check = await checkV2(registry, repo, tag, authHeader);
        }
      }
    }

    if (check.status === 401 || check.status === 403) {
      return {
        kind: "auth_required",
        reason:
          registry === "ghcr.io" && !ghcrToken
            ? "Private GHCR package — set GHCR_TOKEN (read:packages) or run login-ghcr.sh."
            : `${registry} requires credentials for ${repo}.`,
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
