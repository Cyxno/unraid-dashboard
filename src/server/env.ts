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
});

/** True when a Prometheus server is configured for this process. */
export function isPrometheusConfigured(): boolean {
  try {
    return Boolean(getEnv().PROMETHEUS_URL);
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
