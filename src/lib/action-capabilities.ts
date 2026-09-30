/**
 * Normalized action-capability model (v0.9.10): one shape shared by the
 * Docker page, container detail, Automation eligibility, Operations,
 * Settings and the Agent API context. The server (/api/actions/status)
 * remains authoritative for enablement; per-action availability is
 * derived from the live capability list. Actions the verified Unraid API
 * does not expose (restart, pause, unpause) are ALWAYS false here —
 * no caller may infer them.
 */

export interface DockerActionCapabilities {
  enabled: boolean;
  start: boolean;
  stop: boolean;
  /** Never true: the Unraid API exposes no docker restart mutation. */
  restart: false;
  /** Evaluated in v0.9.10 and left unsupported: no compelling use case. */
  pause: false;
  unpause: false;
}

export interface NormalizedActionCapabilities {
  enabled: boolean;
  /** Reason string when disabled (no key material, ever). */
  reason: string | null;
  docker: DockerActionCapabilities;
}

/** Raw /api/actions/status subset the normalizer consumes. */
export interface RawActionStatus {
  enabled: boolean;
  reason?: string | null;
  docker?: string[];
}

export function normalizeActionCapabilities(raw: RawActionStatus | null | undefined): NormalizedActionCapabilities {
  const enabled = raw?.enabled ?? false;
  const dockerActions = enabled ? (raw?.docker ?? []) : [];
  const has = (action: string) => dockerActions.includes(action);
  return {
    enabled,
    reason: raw?.reason ?? null,
    docker: {
      enabled,
      start: has("start"),
      stop: has("stop"),
      restart: false,
      pause: false,
      unpause: false,
    },
  };
}

/** "Available: Start · Stop / Unavailable: Restart" — display helper. */
export function describeDockerCapabilities(caps: DockerActionCapabilities): {
  available: string;
  unavailable: string;
} {
  const available = [caps.start && "Start", caps.stop && "Stop"].filter(Boolean);
  const unavailable = ["Restart", !caps.pause && "Pause"].filter(Boolean) as string[];
  return {
    available: available.length > 0 ? available.join(" · ") : "none",
    unavailable: unavailable.join(" · "),
  };
}
