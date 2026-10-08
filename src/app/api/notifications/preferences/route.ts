import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { ensureNotificationState, scheduleSave } from "@/server/notifications/store";
import { DEFAULT_PREFERENCES, type NotificationPreferences } from "@/server/notifications/types";
import { startNotificationLoop } from "@/server/notifications";

export const dynamic = "force-dynamic";

function coerceBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Saves notification preferences (master/severity/category toggles). */
export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "lan";
  const rate = checkWriteRate("notify-prefs:" + actor + "@" + guard.sourceIp);
  if (!rate.allowed) {
    return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "retry-after": String(Math.ceil((rate.retryAfterMs ?? 1000) / 1000)) } });
  }

  const body = (await request.json().catch(() => null)) as Partial<NotificationPreferences> | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const state = await ensureNotificationState();
  startNotificationLoop();
  const current = state.preferences ?? DEFAULT_PREFERENCES;
  const next: NotificationPreferences = {
    master: coerceBool(body.master, current.master),
    severities: {
      critical: coerceBool(body.severities?.critical, current.severities.critical),
      warning: coerceBool(body.severities?.warning, current.severities.warning),
      info: coerceBool(body.severities?.info, current.severities.info),
    },
    categories: {
      "system-health": coerceBool(body.categories?.["system-health"], current.categories["system-health"]),
      "docker-health": coerceBool(body.categories?.["docker-health"], current.categories["docker-health"]),
      "docker-updates": coerceBool(body.categories?.["docker-updates"], current.categories["docker-updates"]),
      storage: coerceBool(body.categories?.storage, current.categories.storage),
      "beacon-updates": coerceBool(body.categories?.["beacon-updates"], current.categories["beacon-updates"]),
      services: coerceBool(body.categories?.services, current.categories.services),
      resolved: coerceBool(body.categories?.resolved, current.categories.resolved),
    },
  };
  state.preferences = next;
  scheduleSave(0);

  return NextResponse.json({ ok: true, preferences: next }, { headers: { "cache-control": "no-store" } });
}
