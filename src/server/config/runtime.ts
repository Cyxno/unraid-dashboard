
import { loadConfig } from "./store";
import type { AuthMode } from "./types";

/**
 * Runtime resolution with explicit precedence:
 *   ENV (operator override) > persisted UI config > built-in default.
 *
 * A value sourced from ENV is "managed by environment": the UI may display
 * it but writes never take effect while the env var exists.
 */

export type ConfigSource = "env" | "ui" | "default";

export interface ResolvedSetting {
  value: string;
  source: ConfigSource;
}

export function resolveUnraidUrl(): ResolvedSetting {
  const env = process.env.UNRAID_URL;
  if (env) return { value: env, source: "env" };
  const config = loadConfig();
  if (config.unraid.url) return { value: config.unraid.url, source: "ui" };
  return { value: "", source: "default" };
}

export function resolveUnraidApiKey(): ResolvedSetting {
  const env = process.env.UNRAID_API_KEY;
  if (env) return { value: env, source: "env" };
  const config = loadConfig();
  if (config.unraid.apiKey) return { value: config.unraid.apiKey, source: "ui" };
  return { value: "", source: "default" };
}

export function resolvePrometheusUrl(): ResolvedSetting {
  const env = process.env.PROMETHEUS_URL;
  if (env) return { value: env, source: "env" };
  const config = loadConfig();
  if (config.prometheus.url) return { value: config.prometheus.url, source: "ui" };
  return { value: "", source: "default" };
}

/**
 * Effective authentication mode.
 *
 * - env AUTH_MODE=proxy → proxy (deployment-managed, as before).
 * - env AUTH_MODE=disabled (or unset) → the UI-configured mode applies:
 *   "trusted" (default, no login) or "local" (built-in login).
 * - env AUTH_MODE="local" is also accepted for operators who force local
 *   login from the deployment.
 */
export function resolveAuthMode(): { mode: AuthMode; source: ConfigSource } {
  const env = (process.env.AUTH_MODE ?? "").toLowerCase();
  if (env === "proxy") return { mode: "proxy", source: "env" };
  if (env === "local") return { mode: "local", source: "env" };
  const config = loadConfig();
  if (config.security.mode === "local") return { mode: "local", source: "ui" };
  return { mode: "trusted", source: "default" };
}

/** Whether Unraid connection details exist (env or UI). */
export function unraidConnectionConfigured(): boolean {
  const url = resolveUnraidUrl();
  const key = resolveUnraidApiKey();
  return url.value !== "" && key.value !== "";
}

/** Fresh-install detection: no env connection AND setup never completed. */
export async function setupState(): Promise<"unconfigured" | "configured"> {
  if (unraidConnectionConfigured()) return "configured";
  const config = await import("./store").then((m) => m.loadConfigFresh());
  return config.setup.completedAt ? "configured" : "unconfigured";
}
