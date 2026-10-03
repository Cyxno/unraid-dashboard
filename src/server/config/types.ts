/**
 * Beacon configuration layer (v1.3.0).
 *
 * One typed configuration model persisted in /app/data (beacon-config.json,
 * 0600, atomic writes — same durability pattern as notification state).
 *
 * Precedence everywhere: ENV (operator override) > UI config > built-in
 * default. A setting provided via environment is "managed by environment":
 * the UI may display it but writes to it never take effect.
 *
 * Secrets (Unraid API key, local password hash, session secret) live only
 * in this file and are never returned by any API — only configured-flags.
 */

export type AuthMode = "trusted" | "local" | "proxy";

export interface LocalAuthConfig {
  username: string;
  /** scrypt hash: scrypt$N$r$p$salt$hash (never plaintext, never returned). */
  passwordHash: string;
}

export interface BeaconConfig {
  schemaVersion: 1;
  setup: {
    /** null = setup wizard still claimable (one-time). */
    completedAt: string | null;
  };
  security: {
    mode: AuthMode;
    local: LocalAuthConfig | null;
    /** Bumped to invalidate all sessions (logout-all, credential change). */
    sessionEpoch: number;
    /** HMAC secret for session tokens (generated once, persisted here). */
    sessionSecret: string;
  };
  unraid: {
    url: string;
    apiKey: string;
  };
  prometheus: {
    url: string | null;
  };
}

export function defaultConfig(): BeaconConfig {
  return {
    schemaVersion: 1,
    setup: { completedAt: null },
    security: { mode: "trusted", local: null, sessionEpoch: 1, sessionSecret: "" },
    unraid: { url: "", apiKey: "" },
    prometheus: { url: null },
  };
}

export function isValidAuthMode(value: unknown): value is AuthMode {
  return value === "trusted" || value === "local" || value === "proxy";
}
