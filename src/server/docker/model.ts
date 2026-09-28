import { z } from "zod";

/**
 * Central container model for the Docker Update Manager (v0.7.13).
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
  "pipeline_owned",
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

/* ---- ownership labels (v0.7.13) ---------------------------------------------
 * Declarative metadata ONLY: `com.cyxno.*` labels never override server
 * policy. A risk label can only RAISE the computed risk, a policy label can
 * only TIGHTEN it (toward manual) — the server classification always wins.
 */
export type OwnershipManagement = "unraid" | "compose" | "pipeline" | "custom" | "local";

export interface OwnershipLabels {
  management: OwnershipManagement | null;
  policy: Policy | null;
  risk: Risk | null;
  pipeline: { repo: string | null; deployer: string | null; sha: string | null; ref: string | null };
}

const OWNERSHIP_MANAGEMENT: OwnershipManagement[] = ["unraid", "compose", "pipeline", "custom", "local"];
const OWNERSHIP_POLICY: Policy[] = ["manual", "notify", "auto"];
const OWNERSHIP_RISK: Risk[] = ["LOW", "MEDIUM", "HIGH"];

/** Parses the declarative ownership labels; unknown values are ignored. */
export function parseOwnershipLabels(facts: ContainerFacts): OwnershipLabels {
  const managementRaw = facts.labels["com.cyxno.management"];
  const policyRaw = facts.labels["com.cyxno.update.policy"]?.toLowerCase();
  const riskRaw = facts.labels["com.cyxno.update.risk"]?.toUpperCase();
  return {
    management: OWNERSHIP_MANAGEMENT.includes(managementRaw as OwnershipManagement)
      ? (managementRaw as OwnershipManagement)
      : null,
    policy: OWNERSHIP_POLICY.includes(policyRaw as Policy) ? (policyRaw as Policy) : null,
    risk: OWNERSHIP_RISK.includes(riskRaw as Risk) ? (riskRaw as Risk) : null,
    pipeline: {
      repo: facts.labels["com.cyxno.pipeline.repo"] ?? null,
      deployer: facts.labels["com.cyxno.pipeline.deployer"] ?? null,
      sha: facts.labels["com.cyxno.pipeline.sha"] ?? null,
      ref: facts.labels["com.cyxno.pipeline.ref"] ?? null,
    },
  };
}

/* ---- registry/image provenance (v0.7.13) ------------------------------------
 * Answers "does what runs match what the registry serves, and why not?"
 * A mismatch is operational drift (a newer release exists, or the image was
 * built locally) — it is NEVER by itself labeled a compromise signal.
 */
export type ProvenanceState =
  | "synced"
  | "registry_ahead"
  | "local_build"
  | "auth_required"
  | "check_failed"
  | "unknown";

export interface Provenance {
  state: ProvenanceState;
  /** Image ID of the running container. */
  image_id: string | null;
  /** Index (Repo) digest of the running image, as pulled. */
  local_digest: string | null;
  /** Remote tag manifest digest from the registry check. */
  registry_digest: string | null;
  /** True when the image carries no registry digest (built on this host). */
  locally_built: boolean;
  /** Neutral human explanation — never a compromise claim. */
  note: string | null;
}

export function deriveProvenance(facts: ContainerFacts, check: CheckOutcome | undefined): Provenance {
  const locallyBuilt = facts.repoDigests.length === 0;
  const base = {
    image_id: facts.imageId,
    local_digest: localDigestOf(facts),
    registry_digest: check && "remoteDigest" in check ? check.remoteDigest : null,
    locally_built: locallyBuilt,
  } as const;
  if (locallyBuilt) {
    return { ...base, state: "local_build", note: "Image was built on this host (no registry digest) — updates come from its build pipeline." };
  }
  switch (check?.status) {
    case "UP_TO_DATE":
    case "PINNED":
      return { ...base, state: "synced", note: check.status === "PINNED" ? "Digest-pinned image — cannot drift from its pin." : "Running image matches the registry digest for its tag." };
    case "UPDATE_AVAILABLE":
      return { ...base, state: "registry_ahead", note: "Registry tag points to a newer build than the one running — a release was published since this image was pulled." };
    case "AUTH_REQUIRED":
      return { ...base, state: "auth_required", note: check.reason ?? "Registry requires credentials — provenance unverified." };
    case "CHECK_FAILED":
      return { ...base, state: "check_failed", note: check.reason ?? "Registry check failed — provenance unknown." };
    default:
      return { ...base, state: "unknown", note: "No registry check has run yet." };
  }
}

/* ---- rollback readiness (v0.7.13) --------------------------------------------
 * Mutation policy: the machine snapshots the container pre-mutation, so a
 * first-ever update only needs the running image to be resolvable. A stored
 * snapshot makes rollback *proven*, not just possible.
 */
export interface RollbackReadiness {
  /** Server gate: mutation may proceed. */
  ready: boolean;
  level: "ready" | "unproven" | "not_ready";
  snapshot_present: boolean;
  image_present: boolean;
  /** Image ref of the last successful update, from persisted history. */
  last_known_good: string | null;
  /** Timestamp of the last successful update/rollback for this container. */
  validated_at: string | null;
}

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
  networks: string[];
  volumeSources: string[];
  labels: {
    "com.cyxno.update-manager"?: string;
    "com.cyxno.management"?: string;
    "com.cyxno.update.policy"?: string;
    "com.cyxno.update.risk"?: string;
    "com.cyxno.pipeline.repo"?: string;
    "com.cyxno.pipeline.deployer"?: string;
    "com.cyxno.pipeline.sha"?: string;
    "com.cyxno.pipeline.ref"?: string;
    "com.docker.compose.project"?: string;
    "com.docker.compose.service"?: string;
    "com.docker.compose.project.working_dir"?: string;
    "com.docker.compose.project.config_files"?: string;
    "net.unraid.docker.managed"?: string;
  };
  unsupported?: string[];
  externallyManaged?: boolean;
  snapshotPresent?: boolean;
}

/** Operator configuration (env) — which containers have canonical deploy scripts. */
export interface CustomDeployConfig {
  /** container names that are deployed via an allowlisted script */
  containers: string[];
}

/** The central model (v0.7.13). */
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
  ownership: OwnershipLabels;
  provenance: Provenance;
  rollback: RollbackReadiness;
  autoEligible: boolean;
  autoEligibilityReasons: string[];
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
 * Compose projects the operator has declared as owned by an external
 * deployment pipeline (env: comma-separated project names). These are
 * detected, displayed and NEVER mutated by the dashboard.
 */
export function pipelineOwnedProjects(): string[] {
  const raw = process.env["PIPELINE_OWNED_PROJECTS"] ?? "tornscope";
  return raw
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 50);
}

/**
 * Management classification (v0.7.13) — label/metadata based, never name
 * based alone. Order matters: explicit operator labels are the strongest
 * ownership evidence; compose labels next (with pipeline-owned projects
 * taking precedence over plain compose); the Unraid dockerman label after
 * that; operator-configured custom deploys next; locally built images (no
 * registry digests) then; everything with registry digests but no owner is
 * standalone.
 */
export function classifyManagement(
  facts: ContainerFacts,
  customDeployContainers: string[],
): { management_type: ManagementType; management_source: string; update_strategy: UpdateStrategy } {
  if (facts.labels["com.cyxno.update-manager"] === "external") {
    return { management_type: "custom_deploy", management_source: "update-manager label", update_strategy: "manual" };
  }
  if (facts.labels["com.cyxno.management"] === "pipeline") {
    return { management_type: "pipeline_owned", management_source: "cyxno-management label", update_strategy: "manual" };
  }
  const composeProject = facts.labels["com.docker.compose.project"];
  if (composeProject && pipelineOwnedProjects().includes(composeProject.toLowerCase())) {
    const service = facts.labels["com.docker.compose.service"] ?? facts.name;
    return {
      management_type: "pipeline_owned",
      management_source: `pipeline project list:${composeProject}/${service}`,
      update_strategy: "manual",
    };
  }
  if (composeProject && facts.labels["com.docker.compose.service"]) {
    const localBuilt = facts.repoDigests.length === 0;
    return {
      management_type: "compose",
      management_source: `compose:${composeProject}/${facts.labels["com.docker.compose.service"]}`,
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
  /** Last successful update record for this container (rollback context). */
  lastKnownGood?: { image: string; at: string } | null;
  /** Auto-update eligibility verdict computed by the eligibility module. */
  autoEligibility?: { eligible: boolean; reasons: string[] };
}): ManagedContainer {
  const { facts } = input;
  const { registry, repo, tag, digestPin } = parseImageRef(facts.image);
  const { management_type, management_source, update_strategy } = classifyManagement(
    facts,
    input.customDeployContainers,
  );
  const computedRisk = classifyRisk(facts.name, facts.image, input.extraHighRisk);
  // Ownership risk labels may only RAISE risk (declarative metadata; the
  // server classification always wins when it is already higher).
  const ownership = parseOwnershipLabels(facts);
  const riskOrder: Record<Risk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const risk = ownership.risk && riskOrder[ownership.risk] > riskOrder[computedRisk] ? ownership.risk : computedRisk;
  // Policy labels may only tighten toward manual.
  const basePolicy = input.policyOverride ?? defaultPolicyFor(risk);
  const policy = basePolicy === "manual" ? "manual" : ownership.policy === "manual" ? "manual" : basePolicy;

  let update_status: UpdateStatus;
  let update_available = false;
  let remote_digest: string | null = null;
  const local_digest = localDigestOf(facts);

  if (digestPin) {
    update_status = "PINNED";
  } else if (management_type === "compose" && update_strategy === "local_build") {
    update_status = "LOCAL_BUILD";
  } else if (management_type === "local_build" || management_type === "pipeline_owned") {
    // Pipeline-owned projects update through their own pipeline; the
    // dashboard only observes their state.
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
    facts.externallyManaged === true ||
    management_type === "pipeline_owned";

  const imagePresent = Boolean(facts.imageId);
  const snapshotPresent = facts.snapshotPresent === true;
  const rollback: RollbackReadiness = {
    ready: imagePresent,
    level: !imagePresent ? "not_ready" : snapshotPresent ? "ready" : "unproven",
    snapshot_present: snapshotPresent,
    image_present: imagePresent,
    last_known_good: input.lastKnownGood?.image ?? null,
    validated_at: input.lastKnownGood?.at ?? null,
  };

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
    management_source: management_source.startsWith("compose:") || management_source.startsWith("pipeline ")
      ? management_source
      : `${management_source}:${repo}`.slice(0, 120),
    update_strategy,
    update_available: management_type === "pipeline_owned" ? false : update_available,
    update_status,
    risk,
    policy,
    rollback_available: rollback.ready,
    externallyManaged,
    ownership,
    provenance: deriveProvenance(facts, input.check),
    rollback,
    autoEligible: input.autoEligibility?.eligible ?? false,
    autoEligibilityReasons: input.autoEligibility?.reasons ?? [],
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
  ownership: z.object({
    management: z.enum(["unraid", "compose", "pipeline", "custom", "local"]).nullable(),
    policy: z.enum(["manual", "notify", "auto"]).nullable(),
    risk: z.enum(["LOW", "MEDIUM", "HIGH"]).nullable(),
    pipeline: z.object({
      repo: z.string().nullable(),
      deployer: z.string().nullable(),
      sha: z.string().nullable(),
      ref: z.string().nullable(),
    }),
  }),
  provenance: z.object({
    state: z.enum(["synced", "registry_ahead", "local_build", "auth_required", "check_failed", "unknown"]),
    image_id: z.string().nullable(),
    local_digest: z.string().nullable(),
    registry_digest: z.string().nullable(),
    locally_built: z.boolean(),
    note: z.string().nullable(),
  }),
  rollback: z.object({
    ready: z.boolean(),
    level: z.enum(["ready", "unproven", "not_ready"]),
    snapshot_present: z.boolean(),
    image_present: z.boolean(),
    last_known_good: z.string().nullable(),
    validated_at: z.string().nullable(),
  }),
  autoEligible: z.boolean(),
  autoEligibilityReasons: z.array(z.string()),
  health: z.string().nullable(),
  last_checked: z.string().nullable(),
  last_updated: z.string().nullable(),
});
