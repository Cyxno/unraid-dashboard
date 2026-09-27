import type { ManagedContainer } from "./model";

/**
 * Server-side update policy (v0.7.7): which containers may be updated
 * through the dashboard, and why/why not. Mirrors the helper's own
 * blocklist — the dashboard gates first, the helper re-validates.
 */

const BUILTIN_BLOCKED = new Set(["dumb", "dumbscope", "unraid-dashboard", "unraid-dashboard-helper"]);

export interface UpdateGate {
  canUpdate: boolean;
  blockedReason: string | null;
}

/** Computes the gate for one managed container. */
export function updateGate(container: ManagedContainer): UpdateGate {
  const lower = container.name.toLowerCase();

  if (BUILTIN_BLOCKED.has(lower) || lower === "watchtower") {
    const aio = lower === "dumb";
    return {
      canUpdate: false,
      blockedReason: aio
        ? "Part of DUMB AIO — individual update disabled (multiple services run inside)"
        : "Managed externally — dashboard update disabled (own CI/CD or updater)",
    };
  }
  if (container.management_type === "compose") {
    return { canUpdate: false, blockedReason: "Compose-managed — update via docker compose" };
  }
  if (container.management_type === "local_build" || container.update_status === "LOCAL_BUILD") {
    // Operator opt-in for local-build updates (e.g. controlled fixtures);
    // the registry pull is skipped and the local image is used as-is.
    if (process.env["DOCKER_UPDATE_ALLOW_LOCAL_BUILD"] === "true") {
      return { canUpdate: true, blockedReason: null };
    }
    return { canUpdate: false, blockedReason: "Local build — update via its build/deploy pipeline" };
  }
  if (container.update_status === "PINNED") {
    return { canUpdate: false, blockedReason: "Digest pinned — image cannot drift from its pin" };
  }
  if (container.risk === "HIGH") {
    return { canUpdate: false, blockedReason: "HIGH risk (database/auth/proxy/DNS) — update manually via Unraid" };
  }
  if (container.update_status === "AUTH_REQUIRED") {
    return { canUpdate: false, blockedReason: "Registry requires credentials — digest unknown" };
  }
  if (container.update_status === "CHECK_FAILED") {
    return { canUpdate: false, blockedReason: "Registry check failed — no verified update source" };
  }
  if (!container.update_available) {
    return { canUpdate: false, blockedReason: null };
  }
  return { canUpdate: true, blockedReason: null };
}
