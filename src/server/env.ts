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
});

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
