import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { loadConfig, saveConfig } from "../config/store";

/**
 * Built-in local authentication (optional mode).
 *
 * - Passwords: scrypt (N=2^15, r=8, p=1) with a unique 16-byte salt,
 *   stored as `scrypt$N$r$p$salt$hash`. Never plaintext, never reversible.
 * - Sessions: HMAC-SHA256 signed tokens (payload.sessionEpoch + exp) with
 *   a server-generated 32-byte secret persisted in the config file.
 *   HttpOnly cookie; epoch bump invalidates every session (logout-all /
 *   credential change).
 * - Generic errors only — no username enumeration.
 */

const SCRYPT_N = 1 << 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEYLEN = 64;
/** OpenSSL 3.x default maxmem (32 MB) is too small for N=2^15 + r=8 in the
 *  Alpine container; N=2^14 + explicit 64 MB maxmem is OWASP-acceptable
 *  and works in every deployment (bare Node, Alpine, standalone). */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const SESSION_COOKIE = "beacon_session";
const SESSION_SECRET_BYTES = 32;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptHash(password, salt, KEYLEN, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const nStr = parts[1] ?? "";
  const rStr = parts[2] ?? "";
  const pStr = parts[3] ?? "";
  const saltB64 = parts[4] ?? "";
  const hashB64 = parts[5] ?? "";
  try {
    const expected = Buffer.from(hashB64, "base64url");
    const actual = scryptHash(
      password,
      Buffer.from(saltB64, "base64url"),
      expected.length,
      Number(nStr) || SCRYPT_N,
      Number(rStr) || SCRYPT_R,
      Number(pStr) || SCRYPT_P,
    );
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function scryptHash(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number): Buffer {
  return scryptSync(password, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM });
}

export function isValidUsername(username: string): boolean {
  return /^[a-zA-Z0-9_.-]{3,40}$/.test(username);
}

export function isAcceptablePassword(password: string): boolean {
  return typeof password === "string" && password.length >= 10 && password.length <= 200;
}

/** Session secret: generated once, persisted in the config file. */
export function ensureSessionSecret(current: string | undefined): string {
  if (current && current.length >= 32) return current;
  return randomBytes(SESSION_SECRET_BYTES).toString("base64url");
}

export interface SessionPayload {
  username: string;
  epoch: number;
  exp: number;
  nonce: string;
}

export function signSession(
  sessionSecret: string,
  payload: SessionPayload,
): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", sessionSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(
  sessionSecret: string,
  token: string,
  currentEpoch: number,
  now = Date.now(),
): SessionPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const body = parts[0] ?? "";
  const sig = parts[1] ?? "";
  const expected = createHmac("sha256", sessionSecret).update(body).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (typeof payload.exp !== "number" || payload.exp < now) return null;
    if (payload.epoch !== currentEpoch) return null;
    if (typeof payload.username !== "string" || typeof payload.nonce !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

export function newSessionPayload(username: string, epoch: number, now = Date.now()): SessionPayload {
  return { username, epoch, exp: now + SESSION_TTL_MS, nonce: randomBytes(12).toString("base64url") };
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;
export const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

export function sessionCookieAttributes(secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=${""}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ]
    .filter(Boolean)
    .join("; ");
}

export interface LocalAuthState {
  enabled: boolean;
  username: string | null;
  sessionEpoch: number;
}

/** Reads local-auth state for guards (never returns secret material). */
export function localAuthState(): LocalAuthState {
  const config = loadConfig();
  const local = config.security.local;
  return {
    enabled: config.security.mode === "local" && local !== null,
    username: local?.username ?? null,
    sessionEpoch: config.security.sessionEpoch,
  };
}

export function sessionSecret(): string {
  const config = loadConfig();
  // Called after ensureSessionSecret in the guarded flows; empty string is
  // a safe non-secret fallback for unconfigured installs.
  return config.security.sessionSecret || "";
}

export async function setLocalCredentials(
  username: string,
  password: string,
): Promise<void> {
  const config = await loadConfig();
  config.security.local = { username, passwordHash: hashPassword(password) };
  // Credential change invalidates every existing session.
  config.security.sessionEpoch += 1;
  config.security.mode = "local";
  await saveConfig(config);
}

export async function setAuthMode(mode: "trusted" | "local" | "proxy"): Promise<void> {
  const config = await loadConfig();
  config.security.mode = mode;
  if (mode === "trusted") {
    // Leaving local auth invalidates its sessions.
    config.security.sessionEpoch += 1;
  }
  await saveConfig(config);
}

export function verifyLocalLogin(username: string, password: string): { ok: true; username: string } | { ok: false } {
  const config = loadConfig();
  const local = config.security.local;
  if (!local || config.security.mode !== "local") return { ok: false };
  const usernameOk = username === local.username;
  const passwordOk = verifyPassword(password, local.passwordHash);
  if (!(usernameOk && passwordOk)) return { ok: false };
  return { ok: true, username: local.username };
}

export { SESSION_COOKIE_NAME as sessionCookieName, loadConfig, saveConfig };
