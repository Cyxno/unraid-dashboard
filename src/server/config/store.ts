import { readFile, rename, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getEnvSafe } from "@/server/env";
import { defaultConfig, type BeaconConfig } from "./types";

/**
 * Persisted configuration store: /app/data/beacon-config.json.
 *
 * - Atomic writes (temp file → rename), 0600.
 * - Corruption recovery: unreadable file → clean default + warning (the
 *   notification-style baseline prevents any secondary fallout).
 * - Reload-on-change: the file mtime is checked so externally edited
   config (host-side recovery) is picked up without a restart.
 */

const MAX_SIZE = 256 * 1024;

const globalStore = globalThis as unknown as {
  __beaconConfig?: { config: BeaconConfig; mtimeMs: number } | null;
};

export function configFilePath(): string {
  return join(getEnvSafe().AUDIT_DIR, "beacon-config.json");
}

export function loadConfig(): BeaconConfig {
  if (globalStore.__beaconConfig) return globalStore.__beaconConfig.config;
  return defaultConfig();
}

export function configMtimeKnown(): number | null {
  return globalStore.__beaconConfig?.mtimeMs ?? null;
}

/** Reloads from disk when the file changed externally (host-side recovery). */
export async function loadConfigFresh(): Promise<BeaconConfig> {
  const path = configFilePath();
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    globalStore.__beaconConfig = { config: defaultConfig(), mtimeMs: 0 };
    return loadConfig();
  }
  if (globalStore.__beaconConfig && globalStore.__beaconConfig.mtimeMs === mtimeMs) {
    return globalStore.__beaconConfig.config;
  }
  try {
    const raw = await readFile(path, "utf8");
    if (raw.length > MAX_SIZE) throw new Error("config file too large");
    const parsed = JSON.parse(raw) as Partial<BeaconConfig>;
    const base = defaultConfig();
    const config: BeaconConfig = {
      schemaVersion: 1,
      setup: {
        completedAt:
          typeof parsed.setup?.completedAt === "string" ? parsed.setup.completedAt : null,
      },
      security: {
        mode:
          parsed.security?.mode === "local" || parsed.security?.mode === "proxy"
            ? parsed.security.mode
            : "trusted",
        local:
          parsed.security?.local &&
          typeof parsed.security.local.username === "string" &&
          typeof parsed.security.local.passwordHash === "string"
            ? parsed.security.local
            : null,
        sessionEpoch: Number(parsed.security?.sessionEpoch) || 1,
        sessionSecret:
          typeof parsed.security?.sessionSecret === "string" && parsed.security.sessionSecret.length >= 32
            ? parsed.security.sessionSecret
            : "",
      },
      unraid: {
        url: typeof parsed.unraid?.url === "string" ? parsed.unraid.url : "",
        apiKey: typeof parsed.unraid?.apiKey === "string" ? parsed.unraid.apiKey : "",
      },
      prometheus: {
        url: typeof parsed.prometheus?.url === "string" ? parsed.prometheus.url : null,
      },
    };
    globalStore.__beaconConfig = { config, mtimeMs };
    return config;
  } catch (error) {
    console.warn(
      "[config] beacon-config.json unreadable — starting from defaults:",
      error instanceof Error ? error.message : error,
    );
    globalStore.__beaconConfig = { config: defaultConfig(), mtimeMs: 0 };
    return defaultConfig();
  }
}

export async function saveConfig(config: BeaconConfig): Promise<void> {
  const path = configFilePath();
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await rename(temp, path);
  const mtimeMs = (await stat(path)).mtimeMs;
  globalStore.__beaconConfig = { config, mtimeMs };
}

/** Test hook. */
export function resetConfigCache(): void {
  globalStore.__beaconConfig = null;
}
