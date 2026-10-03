import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { loadConfig, saveConfig } from "@/server/config/store";
import { hashPassword, verifyPassword, isValidUsername, isAcceptablePassword } from "@/server/auth/local";
import { checkWriteRate } from "@/server/dashboards/rate-limit";

export const dynamic = "force-dynamic";

/**
 * Updates local auth credentials (username and/or password).
 * Requires the current password for verification. Bumps the session
 * epoch so all existing sessions are invalidated.
 */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "lan";
  const rate = checkWriteRate(`cred-change:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(Math.ceil((rate.retryAfterMs ?? 1000) / 1000)) } });
  }

  const config = loadConfig();
  if (config.security.mode !== "local" || !config.security.local) {
    return NextResponse.json({ error: "Local login is not enabled." }, { status: 404 });
  }

  let body: { username?: string; currentPassword?: string; newPassword?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400 });
  }

  // Verify current password (only when changing the password, not just username).
  if (body.newPassword) {
    if (!body.currentPassword || !verifyPassword(body.currentPassword, config.security.local.passwordHash)) {
      return NextResponse.json({ error: "Current password is incorrect." }, { status: 403 });
    }
    if (!isAcceptablePassword(body.newPassword)) {
      return NextResponse.json({ error: "New password must be at least 10 characters." }, { status: 400 });
    }
    config.security.local.passwordHash = hashPassword(body.newPassword);
    config.security.sessionEpoch += 1;
  }

  if (body.username && isValidUsername(body.username)) {
    config.security.local.username = body.username;
  }

  await saveConfig(config);
  return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
