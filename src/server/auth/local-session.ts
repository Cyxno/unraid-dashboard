import type { NextRequest } from "next/server";
import { loadConfig } from "@/server/config/store";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Session verification for the local auth mode — called by the proxy gate.
 * Shares the HMAC implementation with the auth route (one code path).
 */

export function verifyLocalSessionFromRequest(request: NextRequest): boolean {
  const config = loadConfig();
  if (config.security.mode !== "local" || !config.security.local) return false;
  const sessionSecret = config.security.sessionSecret;
  if (!sessionSecret || sessionSecret.length < 32) return false;

  const token = request.cookies.get("beacon_session")?.value ?? "";
  if (!token) return false;

  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const body = parts[0] ?? "";
  const sig = parts[1] ?? "";

  const expected = createHmac("sha256", sessionSecret).update(body).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return false;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return false;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      exp?: number;
      epoch?: number;
    };
    return (
      typeof payload.exp === "number" &&
      payload.exp > Date.now() &&
      payload.epoch === config.security.sessionEpoch
    );
  } catch {
    return false;
  }
}
