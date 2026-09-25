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

  /* ---- v0.4: write actions (default OFF; requires the action key) ---- */

  /**
   * Separate, narrowly scoped Unraid key for lifecycle mutations
   * (GUEST role + DOCKER:UPDATE_ANY,VMS:UPDATE_ANY only). Never the
   * read key; never sent to the browser; never logged.
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
