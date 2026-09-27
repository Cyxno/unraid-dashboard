import { z } from "zod";

/**
 * Central container model for the Docker Update Manager (v0.7.6).
 *
 * One shape for EVERY container regardless of origin. Classification and
 * update strategies are pure functions here — unit-tested, no docker
 * access. The helper (only Docker-socket component) supplies raw facts;
 * this module turns facts into the managed model.
 */

export const MANAGEMENT_TYPES = [
  "unraid",
  "compose",
  "custom_deploy",
  "standalone",
  "local_build",
  "unknown",
] as const;

export const UPDATE_STRATEGIES = [
  "unraid_template",
  "compose_service",
  "deploy_script",
  "registry_recreate",
  "manual",
  "local_build",
] as const;

export const UPDATE_STATUSES = [
  "UP_TO_DATE",
  "UPDATE_AVAILABLE",
  "PINNED",
  "LOCAL_BUILD",
  "AUTH_REQUIRED",
  "UNKNOWN",
  "CHECK_FAILED",
] as const;

export type ManagementType = (typeof MANAGEMENT_TYPES)[number];
export type UpdateStrategy = (typeof UPDATE_STRATEGIES)[number];
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

export type Risk = "LOW" | "MEDIUM" | "HIGH";
export type Policy = "manual" | "notify" | "auto";

/** Container facts exactly as the helper's /inventory reports them. */
export interface ContainerFacts {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  health: string | null;
  imageId: string | null;
  repoDigests: string[];
  created: string | null;
  labels: {
    "com.cyxno.update-manager"?: string;
    "com.docker.compose.project"?: string;
    "com.docker.compose.service"?: string;
    "com.docker.compose.project.working_dir"?: string;
    "com.docker.compose.project.config_files"?: string;
    "net.unraid.docker.managed"?: string;
  };
  unsupported?: string[];
  externallyManaged?: boolean;
}

/** Operator configuration (env) — which containers have canonical deploy scripts. */
export interface CustomDeployConfig {
  /** container names that are deployed via an allowlisted script */
  containers: string[];
}

/** The central model (Phase B). */
export interface ManagedContainer {
  id: string;
  name: string;
  image: string;
  tag: string;
  image_id: string | null;
  current_digest: string | null;
  remote_digest: string | null;
  registry: string;
  management_type: ManagementType;
  management_source: string;
  update_strategy: UpdateStrategy;
  update_available: boolean;
  update_status: UpdateStatus;
  risk: Risk;
  policy: Policy;
  rollback_available: boolean;
  externallyManaged: boolean;
  health: string | null;
  last_checked: string | null;
  last_updated: string | null;
}

/** Parse "ghcr.io/owner/name:tag" → registry host, repo, tag. */
export function parseImageRef(image: string): { registry: string; repo: string; tag: string; digestPin: string | null } {
  let rest = image;
  let digestPin: string | null = null;
  const atDigest = rest.split("@");
  if (atDigest.length === 2) {
    rest = atDigest[0]!;
    digestPin = atDigest[1]!;
  }
  let registry = "docker.io";
  const firstSlash = rest.indexOf("/");
  if (firstSlash > 0) {
    const candidate = rest.slice(0, firstSlash);
    // Registry hosts contain a dot or a port; plain org names do not.
    if (candidate.includes(".") || candidate.includes(":")) {
      registry = candidate;
      rest = rest.slice(firstSlash + 1);
    }
  }
  const lastColon = rest.lastIndexOf(":");
  let tag = "latest";
  let repo = rest;
  if (lastColon > 0 && !rest.slice(lastColon).includes("/")) {
    tag = rest.slice(lastColon + 1);
    repo = rest.slice(0, lastColon);
  }
  if (registry === "docker.io" && !repo.includes("/")) {
    repo = `library/${repo}`;
  }
  return { registry, repo, tag, digestPin };
}

/** Digest of the running image from its RepoDigests (index digest). */
export function localDigestOf(facts: ContainerFacts): string | null {
  if (facts.repoDigests.length === 0) return null;
  const first = facts.repoDigests[0]!;
  const at = first.lastIndexOf("@");
  return at > 0 ? first.slice(at + 1) : first;
}

/**
 * Management classification (Phase C) — label/metadata based, never name
 * based alone. Order matters: compose labels are the strongest ownership
 * evidence; the Unraid dockerman label next; operator-configured custom
 * deploys next; locally built images (no registry digests) after that;
 * everything with registry digests but no owner is standalone.
 */
export function classifyManagement(
  facts: ContainerFacts,
  customDeployContainers: string[],
): { management_type: ManagementType; management_source: string; update_strategy: UpdateStrategy } {
  if (facts.labels["com.cyxno.update-manager"] === "external") {
    return { management_type: "custom_deploy", management_source: "update-manager label", update_strategy: "manual" };
  }
  if (facts.labels["com.docker.compose.project"] && facts.labels["com.docker.compose.service"]) {
    const localBuilt = facts.repoDigests.length === 0;
    return {
      management_type: "compose",
      management_source: `compose:${facts.labels["com.docker.compose.project"]}/${facts.labels["com.docker.compose.service"]}`,
      update_strategy: localBuilt ? "local_build" : "compose_service",
    };
  }
  if (facts.labels["net.unraid.docker.managed"] === "dockerman") {
    return { management_type: "unraid", management_source: "dockerman-label", update_strategy: "unraid_template" };
  }
  if (customDeployContainers.includes(facts.name)) {
    return { management_type: "custom_deploy", management_source: "operator-config", update_strategy: "deploy_script" };
  }
  if (facts.repoDigests.length === 0) {
    return { management_type: "local_build", management_source: "no-registry-digest", update_strategy: "local_build" };
  }
  return { management_type: "standalone", management_source: "registry-digest-without-owner", update_strategy: "registry_recreate" };
}

/* ---- risk (Phase H): operational impact, not image novelty ---------------- */

const HIGH_RISK_PATTERNS: Array<{ test: RegExp; reason: string }> = [
  { test: /postgres|mysql|mariadb|mongo|redis|valkey|influx|clickhouse/i, reason: "database/stateful store" },
  { test: /authelia|authentik|keycloak|sso/i, reason: "authentication" },
  { test: /nginx-proxy-manager|^npm$|traefik|caddy|haproxy|adguard|pihole|unbound|cloudflared/i, reason: "core networking / reverse proxy / DNS" },
];

const MEDIUM_RISK_PATTERNS: RegExp[] = [
  /immich|paperless|nextcloud|cloudreve|gitea|wikijs|bookstack|kavita|audiobookshelf|spotweb/i,
];
void MEDIUM_RISK_PATTERNS;

/** Risk from operational impact; operator can always extend via env. */
export function classifyRisk(name: string, image: string, extraHighRisk: string[]): Risk {
  const haystack = `${name} ${image}`;
  if (extraHighRisk.some((entry) => haystack.toLowerCase().includes(entry.toLowerCase()))) return "HIGH";
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (pattern.test.test(haystack)) return "HIGH";
  }
  for (const pattern of MEDIUM_RISK_PATTERNS) {
    if (pattern.test(haystack)) return "MEDIUM";
  }
  return "LOW";
}

/** Default policy per risk (Phase H): only explicit opt-in ever auto-updates. */
export function defaultPolicyFor(risk: Risk): Policy {
  if (risk === "HIGH") return "manual";
  return "notify";
}

/* ---- remote digest comparison (Phase D) ------------------------------------ */

export type CheckOutcome =
  | { status: "UP_TO_DATE" | "UPDATE_AVAILABLE" | "PINNED"; remoteDigest: string; localDigest: string | null }
  | { status: "LOCAL_BUILD" | "AUTH_REQUIRED" | "UNKNOWN" | "CHECK_FAILED"; remoteDigest: null; localDigest: string | null; reason?: string };

/** Compares the local index digest with the remote tag digest. */
export function compareDigests(localDigest: string | null, remoteDigest: string): CheckOutcome {
  if (localDigest !== null && localDigest === remoteDigest) {
    return { status: "UP_TO_DATE", remoteDigest, localDigest };
  }
  return { status: "UPDATE_AVAILABLE", remoteDigest, localDigest };
}

/** Build the full managed model from facts + an optional check result. */
export function buildManagedContainer(input: {
  facts: ContainerFacts;
  customDeployContainers: string[];
  extraHighRisk: string[];
  check?: CheckOutcome;
  policyOverride?: Policy;
  checkedAt: string;
  lastUpdated?: string | null;
}): ManagedContainer {
  const { facts } = input;
  const { registry, repo, tag, digestPin } = parseImageRef(facts.image);
  const { management_type, management_source, update_strategy } = classifyManagement(
    facts,
    input.customDeployContainers,
  );
  const risk = classifyRisk(facts.name, facts.image, input.extraHighRisk);
  const policy = input.policyOverride ?? defaultPolicyFor(risk);

  let update_status: UpdateStatus;
  let update_available = false;
  let remote_digest: string | null = null;
  const local_digest = localDigestOf(facts);

  if (digestPin) {
    update_status = "PINNED";
  } else if (management_type === "compose" && update_strategy === "local_build") {
    update_status = "LOCAL_BUILD";
  } else if (management_type === "local_build") {
    update_status = "LOCAL_BUILD";
  } else if (!input.check) {
    update_status = "UNKNOWN";
  } else if (input.check.status === "AUTH_REQUIRED") {
    update_status = "AUTH_REQUIRED";
  } else if (input.check.status === "CHECK_FAILED") {
    update_status = "CHECK_FAILED";
  } else {
    update_status = input.check.status;
    remote_digest = input.check.remoteDigest;
    update_available = input.check.status === "UPDATE_AVAILABLE";
  }

  const externallyManaged =
    facts.labels["com.cyxno.update-manager"] === "external" ||
    facts.externallyManaged === true;
  return {
    id: facts.id,
    name: facts.name,
    image: facts.image,
    tag,
    image_id: facts.imageId,
    current_digest: local_digest,
    remote_digest,
    registry,
    management_type,
    management_source: management_source.startsWith("compose:") ? management_source : `${management_source}:${repo}`.slice(0, 120),
    update_strategy,
    update_available,
    update_status,
    risk,
    policy,
    rollback_available: false, // filled by the rollback layer once history exists
    externallyManaged,
    health: facts.health,
    last_checked: input.check ? input.checkedAt : null,
    last_updated: input.lastUpdated ?? null,
  };
}

/** Zod schema for API output (validated, no arbitrary content). */
export const managedContainerSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  tag: z.string(),
  image_id: z.string().nullable(),
  current_digest: z.string().nullable(),
  remote_digest: z.string().nullable(),
  registry: z.string(),
  management_type: z.enum(MANAGEMENT_TYPES),
  management_source: z.string(),
  update_strategy: z.enum(UPDATE_STRATEGIES),
  update_available: z.boolean(),
  update_status: z.enum(UPDATE_STATUSES),
  risk: z.enum(["LOW", "MEDIUM", "HIGH"]),
  policy: z.enum(["manual", "notify", "auto"]),
  rollback_available: z.boolean(),
  externallyManaged: z.boolean(),
  health: z.string().nullable(),
  last_checked: z.string().nullable(),
  last_updated: z.string().nullable(),
});
