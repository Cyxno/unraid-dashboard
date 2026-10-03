import { randomBytes, timingSafeEqual } from "node:crypto";
import { rename, readFileSync, statSync } from "node:fs";
import { readFile, rm as rmProm, mkdir as mkdirProm, writeFile as writeFileProm, rename as renameProm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getEnvSafe } from "@/server/env";
import { loadConfigFresh, saveConfig, loadConfig } from "./config/store";
import { unraidConnectionConfigured } from "./config/runtime";
import { setLocalCredentials, hashPassword, verifyPassword } from "./auth/local";
import type { AuthMode } from "./config/types";

/**
 * First-time setup state machine (v1.3.0).
 *
 * States: "unconfigured" (wizard claimable) → "configured" (locked).
 *
 * Bootstrap security: a fresh install generates a one-time, high-entropy
 * setup token stored in a 0600 file under the appdata root. The wizard
 * requires this token; the claim is atomic and single-shot; after
 * completion the token file is deleted and further setup mutations are
 * rejected (409). Rate limited per source IP by the route.
 *
 * Existing installs (env-provided connection details) are detected as
 * "configured" automatically and never see the wizard.
 */

const TOKEN_BYTES = 32;
const MAX_TOKEN_ATTEMPTS = 5;
const TOKEN_WINDOW_MS = 10 * 60 * 1000;

function tokenFilePath(): string {
  return join(getEnvSafe().AUDIT_DIR, "setup-token.txt");
}

const globalStore = globalThis as unknown as {
  __setupTokenAttempts?: { count: number; windowStart: number };
  __setupLock?: boolean;
};

export type SetupState = "unconfigured" | "configured";

export async function getSetupState(): Promise<{
  state: SetupState;
  tokenPresent: boolean;
}> {
  const configured = (await setupStateResolved()) === "configured";
  let tokenPresent = false;
  if (!configured) {
    try {
      tokenPresent = statSync(tokenFilePath()).size > 0;
    } catch {
      tokenPresent = false;
    }
  }
  return { state: configured ? "configured" : "unconfigured", tokenPresent };
}

async function setupStateResolved(): Promise<SetupState> {
  return (await import("./config/runtime")).setupState();
}

/** Generates the one-time setup token file (called at server boot when
 *  the install is unconfigured). Idempotent: does not overwrite. */
export async function ensureSetupToken(): Promise<void> {
  const { state } = await getSetupState();
  if (state === "configured") return;
  try {
    const existing = await readFile(tokenFilePath(), "utf8");
    if (existing.trim().length >= 32) return;
  } catch {
    // not present — generate below
  }
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const path = tokenFilePath();
  await mkdirProm(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFileProm(temp, token + "\n", { mode: 0o600 });
  await renameProm(temp, path);
}

function readToken(): string | null {
  try {
    return readFileSync(tokenFilePath(), "utf8").trim();
  } catch {
    return null;
  }
}

function tokenValid(supplied: string): boolean {
  const expected = readToken();
  if (!expected || expected.length < 32) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function rateLimited(): boolean {
  const entry = globalStore.__setupTokenAttempts;
  const now = Date.now();
  if (!entry || now - entry.windowStart > TOKEN_WINDOW_MS) {
    globalStore.__setupTokenAttempts = { count: 1, windowStart: now };
    return false;
  }
  entry.count += 1;
  globalStore.__setupTokenAttempts = entry;
  return entry.count > MAX_TOKEN_ATTEMPTS;
}

export interface SetupClaim {
  token: string;
  unraidUrl: string;
  unraidApiKey: string;
  prometheusUrl?: string;
  securityMode: "trusted" | "local";
  localUsername?: string;
  localPassword?: string;
}

export class SetupError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

/** Validates and claims setup. Atomic: single process, lock-guarded. */
export async function claimSetup(claim: SetupClaim): Promise<void> {
  if ((await setupStateResolved()) === "configured") {
    throw new SetupError("Setup has already been completed.", 409);
  }
  if (rateLimited()) {
    throw new SetupError("Too many setup attempts — try again later.", 429);
  }

  if (globalStore.__setupLock) throw new SetupError("Setup in progress.", 409);
  globalStore.__setupLock = true;
  try {
    // Re-read under the lock: another concurrent request may have claimed.
    if ((await setupStateResolved()) === "configured") {
      throw new SetupError("Setup has already been completed.", 409);
    }
    if (!tokenValid(claim.token)) {
      throw new SetupError("Invalid setup token.", 403);
    }

    // Validate inputs (schema-level; minimal, strict).
    const url = claim.unraidUrl.replace(/\/+$/, "");
    if (!/^https?:\/\//.test(url) || url.length > 500) {
      throw new SetupError("Invalid Unraid API URL.", 400);
    }
    if (!claim.unraidApiKey || claim.unraidApiKey.length > 500) {
      throw new SetupError("Invalid Unraid API key.", 400);
    }
    if (claim.prometheusUrl && !/^https?:\/\//.test(claim.prometheusUrl)) {
      throw new SetupError("Invalid Prometheus URL.", 400);
    }
    const mode: AuthMode = claim.securityMode === "local" ? "local" : "trusted";
    if (mode === "local") {
      const { isValidUsername, isAcceptablePassword } = await import("./auth/local");
      if (!isValidUsername(claim.localUsername ?? "")) {
        throw new SetupError("Invalid username.", 400);
      }
      if (!isAcceptablePassword(claim.localPassword ?? "")) {
        throw new SetupError("Password must be at least 10 characters.", 400);
      }
    }

    // Persist: config + credentials atomically via the config store.
    const config = await loadConfigFresh();
    config.unraid.url = url;
    config.unraid.apiKey = claim.unraidApiKey;
    config.prometheus.url = claim.prometheusUrl?.replace(/\/+$/, "") || null;
    config.security.mode = mode;
    if (mode === "local") {
      setLocalCredentialsSync(
        config,
        claim.localUsername ?? "",
        claim.localPassword ?? "",
      );
    }
    config.setup.completedAt = new Date().toISOString();
    await saveConfig(config);

    // Token is single-shot: remove it so /setup can never be reclaimed.
    try {
      await rmProm(tokenFilePath());
    } catch {
      // already absent — fine
    }
  } finally {
    globalStore.__setupLock = false;
  }
}

function setLocalCredentialsSync(
  config: Parameters<typeof saveConfig>[0],
  username: string,
  password: string,
): void {
  config.security.local = { username, passwordHash: hashPassword(password) };
  config.security.sessionEpoch += 1;
}

export function verifyLocalLogin(
  username: string,
  password: string,
): { ok: true; username: string } | { ok: false } {
  const config = loadConfig();
  const local = config.security.local;
  if (!local || config.security.mode !== "local") return { ok: false };
  const usernameOk = username === local.username;
  const passwordOk = verifyPassword(password, local.passwordHash);
  if (!(usernameOk && passwordOk)) return { ok: false };
  return { ok: true, username: local.username };
}

