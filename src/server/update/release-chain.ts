import { readFile } from "node:fs/promises";
import { getEnvSafe } from "@/server/env";
import type { UpdateHelperStatus } from "@/server/update/helper-client";
import type { ManagedContainer } from "@/server/docker/model";
import type { UpdateHistoryEntry } from "@/server/update/history";

/**
 * Release-chain status (v0.7.14): one verdict for the chain
 * tag → CI → GHCR → host credential → remote pull → running digest.
 * Pure derivation over facts the app already fetches; no new host access,
 * no credential material.
 */

export type ProvenanceBadge = "Registry verified" | "Local build" | "Registry ahead" | "Unknown provenance";

export interface ReleaseChain {
  /** Helper's hourly pull probe: the pull-truth source. */
  ghcrAuthenticated: boolean | null;
  remotePullAvailable: boolean | null;
  /** Strict remote mode active on the helper (UPDATE_REQUIRE_REMOTE). */
  requireRemote: boolean | null;
  lastRemotePull: {
    at: string;
    to: string;
    digest: string | null;
    registryDigest: string | null;
    digestMatch: boolean | null;
    source: string;
  } | null;
  running: { imageId: string | null; repoDigest: string | null };
  /** Remote digest of the tag the dashboard container runs. */
  registryDigest: string | null;
  /** running RepoDigest == remote tag digest. */
  digestMatch: boolean | null;
  provenanceBadge: ProvenanceBadge;
  bootPersistence: {
    verifiedAt: string | null;
    passed: boolean | null;
    failures: number | null;
    warnings: number | null;
  };
}

interface BootMarker {
  verifiedAt?: string;
  passed?: boolean;
  failures?: number;
  warnings?: number;
  scriptVersion?: string;
}

/** Reads the boot-persistence verification marker (written by the audit script). */
export async function readBootMarker(): Promise<BootMarker | null> {
  try {
    const raw = await readFile(`${getEnvSafe().AUDIT_DIR}/boot-verification.json`, "utf8");
    const parsed = JSON.parse(raw) as BootMarker;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function badgeFromProvenance(state: ManagedContainer["provenance"]["state"]): ProvenanceBadge {
  switch (state) {
    case "synced":
      return "Registry verified";
    case "local_build":
      return "Local build";
    case "registry_ahead":
      return "Registry ahead";
    default:
      return "Unknown provenance";
  }
}

/** Safe digest rendering for UI: keep the sha256: prefix plus 12 chars. */
export function shortDigest(digest: string | null | undefined): string | null {
  if (!digest) return null;
  return digest.slice(0, 7 + 12);
}

export function buildReleaseChain(input: {
  helper: UpdateHelperStatus | null;
  appContainer: ManagedContainer | null;
  history: UpdateHistoryEntry[];
  bootMarker: BootMarker | null;
}): ReleaseChain {
  const { helper, appContainer, history, bootMarker } = input;
  const pullState = helper?.reachable ? helper.pullAvailable : null;
  const last = helper?.lastUpdate ?? null;
  const lastSuccessful = last?.result === "success" ? last : null;

  // Prefer the freshest successful self-update entry from history, falling
  // back to the helper's live lastUpdate (survives dashboard replacement).
  const historyRemote = [...history]
    .reverse()
    .find((entry) => entry.result === "success" && entry.usedLocalImage === false);

  const lastRemotePull = lastSuccessful
    ? {
        at: lastSuccessful.finishedAt,
        to: versionFromRef(lastSuccessful.to),
        digest: lastSuccessful.digest ?? null,
        registryDigest: (lastSuccessful as { registryDigest?: string | null }).registryDigest ?? null,
        digestMatch: (lastSuccessful as { digestMatch?: boolean | null }).digestMatch ?? null,
        source: (lastSuccessful as { source?: string }).source ?? (lastSuccessful.usedLocalImage ? "local" : "registry"),
      }
    : historyRemote
      ? {
          at: historyRemote.timestamp,
          to: historyRemote.toVersion,
          digest: historyRemote.toDigest,
          registryDigest: historyRemote.registryDigest ?? null,
          digestMatch: historyRemote.digestMatch ?? null,
          source: "registry",
        }
      : null;

  const provenance = appContainer?.provenance;
  const runningRepoDigest = provenance?.local_digest ?? null;

  // The app's own registry HEAD is anonymous by design (no credential in
  // app env), so for a PRIVATE package it can never see the manifest. The
  // helper's strict remote pull is the stronger signal: when it pulled the
  // RUNNING version from the registry with in-machine digest equality,
  // that registry digest is authoritative for the running tag.
  const strictAppliesToRunning =
    lastRemotePull !== null &&
    lastRemotePull.source === "registry" &&
    lastRemotePull.digestMatch === true &&
    appContainer?.tag != null &&
    lastRemotePull.to === appContainer.tag;
  const registryDigest =
    provenance?.registry_digest ?? (strictAppliesToRunning ? lastRemotePull.registryDigest : null);
  const digestMatch =
    runningRepoDigest && registryDigest ? runningRepoDigest === registryDigest : null;

  let provenanceBadge: ProvenanceBadge;
  if (digestMatch === true || provenance?.state === "synced") {
    provenanceBadge = "Registry verified";
  } else {
    provenanceBadge = provenance ? badgeFromProvenance(provenance.state) : "Unknown provenance";
  }

  return {
    ghcrAuthenticated: pullState === null ? null : !helper?.pullAuthRequired,
    remotePullAvailable: pullState,
    requireRemote: helper?.requireRemote ?? null,
    lastRemotePull,
    running: {
      imageId: appContainer?.image_id ?? null,
      repoDigest: runningRepoDigest,
    },
    registryDigest,
    digestMatch,
    provenanceBadge,
    bootPersistence: {
      verifiedAt: bootMarker?.verifiedAt ?? null,
      passed: typeof bootMarker?.passed === "boolean" ? bootMarker.passed : null,
      failures: typeof bootMarker?.failures === "number" ? bootMarker.failures : null,
      warnings: typeof bootMarker?.warnings === "number" ? bootMarker.warnings : null,
    },
  };
}

function versionFromRef(ref: string): string {
  const tag = ref.includes(":") ? ref.split(":").pop() ?? ref : ref;
  return tag.replace(/^v/, "").slice(0, 32);
}
