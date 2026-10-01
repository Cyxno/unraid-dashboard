import { z } from "zod";

/**
 * Server-only environment variables. Never import this module from
 * client components — it throws when required values are missing.
 */
const envSchema = z.object({
  UNRAID_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, "")),
  UNRAID_API_KEY: z.string().min(1),
  /** Unraid API timeouts in milliseconds. */
  UNRAID_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  /** Base URL override for the GraphQL endpoint; defaults to `${UNRAID_URL}/graphql`. */
  UNRAID_GRAPHQL_PATH: z.string().startsWith("/").default("/graphql"),
  /**
   * Base URL of a Prometheus server for time-series metrics. Optional:
   * without it the dashboard still serves all Unraid state and marks
   * Prometheus-derived metrics as unavailable. No credentials are sent.
   */
  PROMETHEUS_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, ""))
    .optional(),
  /** Prometheus request timeout in milliseconds. */
  PROMETHEUS_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  /* ---- v0.4: access control (all optional; defaults keep LAN mode) ---- */

  /**
   * Authentication mode:
   * - "disabled" (default): trusted-LAN behavior, no identity required.
   * - "proxy": requests must arrive via a configured trusted reverse proxy
   *   that injects the identity header. Direct requests are rejected.
   */
  AUTH_MODE: z.enum(["disabled", "proxy"]).default("disabled"),
  /** Identity header injected by the trusted reverse proxy (proxy mode). */
  AUTH_HEADER: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/)
    .default("X-Forwarded-User"),
  /** Comma-separated allowlist of proxy identities; empty = any identity. */
  AUTH_ALLOWED_USERS: z.string().default(""),
  /**
   * Comma-separated IPs/CIDRs allowed to set the identity header
   * (proxy mode). Empty defaults to loopback + private ranges.
   */
  AUTH_TRUSTED_PROXIES: z.string().default(""),

  /* ---- write actions (default OFF; requires the action key) ---- */

  /**
   * Separate, narrowly scoped Unraid key for lifecycle mutations
   * (DOCKER:UPDATE_ANY only — the only write permission Beacon needs).
   * Never the read key; never sent to the browser; never logged.
   */
  UNRAID_ACTION_API_KEY: z.string().min(1).optional(),
  /** Master switch for write actions; actions stay disabled without it. */
  ENABLE_ACTIONS: z
    .string()
    .default("false")
    .transform((value) => ["1", "true", "yes"].includes(value.trim().toLowerCase())),
  /** Directory for the append-only action audit log. */
  AUDIT_DIR: z.string().default("/app/data"),
  /**
   * Directory for shared dashboard JSON files (v0.6). Lives on the same
   * narrow app-data volume; never a broad host mount.
   */
  DASHBOARDS_DIR: z.string().default("/app/data/dashboards"),

  /**
   * External origin (scheme + host[:port]) the dashboard is served on
   * when behind a reverse proxy with a different hostname. Used for
   * same-origin (CSRF) validation of write requests alongside the
   * request Host header.
   */
  PUBLIC_BASE_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, ""))
    .optional(),
  /** Action cooldown per (container, action) in milliseconds. */
  ACTION_COOLDOWN_MS: z.coerce.number().int().positive().default(10_000),
  /** Maximum action requests per minute per user/IP. */
  ACTION_RATE_PER_MINUTE: z.coerce.number().int().positive().default(12),

  /* ---- v0.4: optional GHCR update check ---- */

  /**
   * Server-side token for checking the private GHCR package's latest
   * tags (read:packages). Optional; when absent the update check
   * reports "unknown" instead of failing. Never exposed to the browser.
   */
  GHCR_TOKEN: z.string().min(1).optional(),
  GHCR_IMAGE: z
    .string()
    .regex(/^[a-z0-9-]+\/[a-z0-9-]+$/)
    .default("cyxno/unraid-dashboard"),

  /* ---- v0.7: update helper (the only component with Docker access) ---- */

  /**
   * Base URL of the local update helper (default http://127.0.0.1:8790).
   * The helper binds localhost only and updates exactly one container.
   */
  UPDATE_HELPER_URL: z
    .string()
    .url()
    .transform((value) => value.replace(/\/+$/, ""))
    .optional(),
  /**
   * Shared secret for update requests to the helper (Bearer). Required
   * for in-app updates; its presence never reaches the browser — only
   * "updates available: yes/no".
   */
  UPDATE_HELPER_TOKEN: z.string().min(32).optional(),
  /** Agent API (v0.9.4): dedicated read-only machine credential. Bearer
   * token, min 32 chars. When unset, the Agent API is disabled unless
   * AGENT_API_TRUST_LOCAL is explicitly true. Never exposed to the browser. */
  AGENT_API_TOKEN: z.string().min(32).optional(),
  /** Explicit opt-in for passwordless access from trusted-local sources
   * (loopback/LAN per the firewall boundary). Default: false. */
  AGENT_API_TRUST_LOCAL: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  /**
   * Secret the reverse proxy must inject (AUTH_PROXY_SECRET header) in
   * proxy auth mode: direct clients cannot spoof an identity header
   * without it. Fail-closed when unset in proxy mode.
   */
  AUTH_PROXY_SECRET: z.string().min(16).optional(),
  AUTH_PROXY_SECRET_HEADER: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/)
    .default("X-Dashboard-Auth-Token"),
});

/** True when a Prometheus server is configured for this process. */
export function isPrometheusConfigured(): boolean {
  try {
    return Boolean(getEnv().PROMETHEUS_URL);
  } catch {
    return false;
  }
}

/**
 * True when write actions are fully configured AND enabled:
 * requires ENABLE_ACTIONS truthy and a separate action key. The
 * read-only dashboard never depends on either.
 */
export function areActionsEnabled(): boolean {
  try {
    const env = getEnv();
    return env.ENABLE_ACTIONS && Boolean(env.UNRAID_ACTION_API_KEY);
  } catch {
    return false;
  }
}

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `Invalid server environment configuration (${issues}). ` +
        "Set UNRAID_URL and UNRAID_API_KEY — see .env.example.",
    );
  }
  cached = parsed.data;
  return cached;
}

/** Test hook: clears the memo so env changes are picked up. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Safe variant for diagnostics paths: returns defaults instead of
 * throwing when required vars are missing (boot-time diagnostics).
 * Placeholder Unraid values are never used for requests — only
 * AUDIT_DIR/DASHBOARDS_DIR defaults are meaningful here.
 */
export function getEnvSafe(): Env {
  try {
    return getEnv();
  } catch {
    return envSchema.parse({
      UNRAID_URL: "http://127.0.0.1",
      UNRAID_API_KEY: "unavailable",
    });
  }
}
