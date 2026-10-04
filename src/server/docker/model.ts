import { z } from "zod";
import type { RegistryCheckResult } from "@/server/docker/registry";

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

export function deriveProvenance(
  facts: ContainerFacts,
  verdict: ContainerUpdateVerdict,
): Provenance {
  const base = {
    image_id: facts.imageId,
    local_digest: localDigestOf(facts),
    registry_digest: verdict.remote_digest,
    // Evidence-based (v1.3.9): only the registry's own 404 proves a local
    // image — a missing digest proves nothing.
    locally_built: verdict.update_status === "LOCAL_BUILD",
  } as const;
  if (verdict.update_status === "LOCAL_BUILD") {
    return { ...base, state: "local_build", note: verdict.reason ?? "Image was built on this host (registry has no such repository) — updates come from its build pipeline." };
  }
  switch (verdict.update_status) {
    case "UP_TO_DATE":
    case "PINNED":
      return { ...base, state: "synced", note: verdict.update_status === "PINNED" ? "Digest-pinned image — cannot drift from its pin." : "Running image matches the registry digest for its tag." };
    case "UPDATE_AVAILABLE":
      return { ...base, state: "registry_ahead", note: "Registry tag points to a newer build than the one running — a release was published since this image was pulled." };
    case "AUTH_REQUIRED":
      return { ...base, state: "auth_required", note: verdict.reason ?? "Registry requires credentials — provenance unverified." };
    case "CHECK_FAILED":
      return { ...base, state: "check_failed", note: verdict.reason ?? "Registry check failed — provenance unknown." };
    default:
      return { ...base, state: "unknown", note: verdict.reason ?? "No registry check has run yet." };
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
 * Management classification (v0.7.13, evidence rules revised v1.3.9) —
 * label/metadata based, never name based alone. Order matters: explicit
 * operator labels are the strongest ownership evidence; compose labels next
 * (with pipeline-owned projects taking precedence over plain compose); the
 * Unraid dockerman label after that; operator-configured custom deploys
 * next; everything else without an owner is standalone.
 *
 * v1.3.9: an EMPTY RepoDigests list is no longer local-build evidence.
 * A transient docker inspect failure, a multi-arch pull quirk or an image
 * loaded without digest metadata must never reclassify a registry image
 * as a local build. LOCAL_BUILD is decided by {@link canonicalUpdateState}
 * from registry evidence (a 404 from the image's own registry) instead.
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
    return {
      management_type: "compose",
      management_source: `compose:${composeProject}/${facts.labels["com.docker.compose.service"]}`,
      update_strategy: "compose_service",
    };
  }
  if (facts.labels["net.unraid.docker.managed"] === "dockerman") {
    return { management_type: "unraid", management_source: "dockerman-label", update_strategy: "unraid_template" };
  }
  if (customDeployContainers.includes(facts.name)) {
    return { management_type: "custom_deploy", management_source: "operator-config", update_strategy: "deploy_script" };
  }
  // No owner evidence: registry-managed by default. Whether the image is
  // truly local is proven (or refuted) by the registry check, see
  // canonicalUpdateState — never from the digest list alone.
  return { management_type: "standalone", management_source: "no-owner-evidence", update_strategy: "registry_recreate" };
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

/** Canonical per-container update verdict, shared by every consumer. */
export interface ContainerUpdateVerdict {
  update_status: UpdateStatus;
  update_available: boolean;
  remote_digest: string | null;
  local_digest: string | null;
  /** Evidence/reason when the verdict is not a definitive comparison. */
  reason?: string;
}

export type CheckOutcome =
  | { status: "UP_TO_DATE" | "UPDATE_AVAILABLE" | "PINNED"; remoteDigest: string; localDigest: string | null }
  | { status: "LOCAL_BUILD" | "AUTH_REQUIRED" | "UNKNOWN" | "CHECK_FAILED"; remoteDigest: null; localDigest: string | null; reason?: string };

/**
 * CANONICAL update verdict (v1.3.9) — the single source of truth that row
 * badges, counters, filters, the updates panel, notifications and agent
 * issues all derive from. No consumer recomputes update state.
 *
 * Evidence rules:
 *  - PINNED: image referenced by immutable digest (cannot drift).
 *  - LOCAL_BUILD: ONLY when the image's own registry answers 404 for the
 *    repository. A missing local RepoDigest is NOT evidence — a docker
 *    inspect hiccup or a digest-less load must not reclassify registry
 *    images (the v1.3.8 "62 local builds" bug).
 *  - UPDATE_AVAILABLE: both digests known and different. Without a local
 *    digest the honest answer is UNKNOWN — never a fabricated verdict.
 *  - AUTH_REQUIRED / CHECK_FAILED / UNKNOWN: registry comparison did not
 *    produce a verdict; no claim either way.
 */
export function canonicalUpdateState(
  facts: ContainerFacts,
  raw: RegistryCheckResult | null | undefined,
): ContainerUpdateVerdict {
  const { digestPin } = parseImageRef(facts.image);
  const localDigest = localDigestOf(facts);
  if (digestPin) {
    return { update_status: "PINNED", update_available: false, remote_digest: digestPin, local_digest: localDigest };
  }
  if (!raw) {
    return { update_status: "UNKNOWN", update_available: false, remote_digest: null, local_digest: localDigest, reason: "No registry check has run yet." };
  }
  switch (raw.kind) {
    case "pinned":
      return { update_status: "PINNED", update_available: false, remote_digest: raw.remoteDigest, local_digest: localDigest };
    case "not_found":
      return { update_status: "LOCAL_BUILD", update_available: false, remote_digest: null, local_digest: localDigest, reason: raw.reason };
    case "auth_required":
      return { update_status: "AUTH_REQUIRED", update_available: false, remote_digest: null, local_digest: localDigest, reason: raw.reason };
    case "failed":
      return { update_status: "CHECK_FAILED", update_available: false, remote_digest: null, local_digest: localDigest, reason: raw.reason };
    case "digest":
      if (localDigest === null) {
        return { update_status: "UNKNOWN", update_available: false, remote_digest: raw.remoteDigest, local_digest: null, reason: "Local registry digest unknown — image has no RepoDigests, cannot compare." };
      }
      if (localDigest === raw.remoteDigest) {
        return { update_status: "UP_TO_DATE", update_available: false, remote_digest: raw.remoteDigest, local_digest: localDigest };
      }
      return { update_status: "UPDATE_AVAILABLE", update_available: true, remote_digest: raw.remoteDigest, local_digest: localDigest };
  }
}

/**
 * THE verdict every consumer uses (v1.3.9): canonical registry state +
 * management policy in one function. Pipeline-owned containers observe
 * but never claim updates — their pipeline is the updater. Used by
 * buildManagedContainer AND the cached summary so no second derivation
 * can diverge (the 15-vs-14 bug).
 */
export function updateVerdictForFacts(
  facts: ContainerFacts,
  raw: RegistryCheckResult | null | undefined,
  customDeployContainers: string[] = [],
): ContainerUpdateVerdict & { management_type: ManagementType } {
  const { management_type } = classifyManagement(facts, customDeployContainers);
  const verdict = canonicalUpdateState(facts, raw);
  if (management_type === "pipeline_owned") {
    return { ...verdict, update_available: false, update_status: "LOCAL_BUILD", management_type };
  }
  return { ...verdict, management_type };
}

/** Build the full managed model from facts + an optional check result. */
export function buildManagedContainer(input: {
  facts: ContainerFacts;
  customDeployContainers: string[];
  extraHighRisk: string[];
  /** Raw cached registry outcome (null = not checked yet). */
  rawCheck?: RegistryCheckResult | null;
  policyOverride?: Policy;
  checkedAt: string;
  lastUpdated?: string | null;
  /** Last successful update record for this container (rollback context). */
  lastKnownGood?: { image: string; at: string } | null;
  /** Auto-update eligibility verdict computed by the eligibility module. */
  autoEligibility?: { eligible: boolean; reasons: string[] };
}): ManagedContainer {
  const { facts } = input;
  const { registry, repo, tag } = parseImageRef(facts.image);
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

  const canonical = updateVerdictForFacts(facts, input.rawCheck ?? null, input.customDeployContainers);
  const update_status: UpdateStatus = canonical.update_status;
  const update_available = canonical.update_available;
  const remote_digest = canonical.remote_digest;
  const local_digest = canonical.local_digest;

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
    provenance: deriveProvenance(facts, canonical),
    rollback,
    autoEligible: input.autoEligibility?.eligible ?? false,
    autoEligibilityReasons: input.autoEligibility?.reasons ?? [],
    health: facts.health,
    last_checked: input.rawCheck ? input.checkedAt : null,
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
