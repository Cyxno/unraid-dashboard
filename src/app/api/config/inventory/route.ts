import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { resolveUnraidUrl, resolveUnraidApiKey, resolvePrometheusUrl, resolveAuthMode } from "@/server/config/runtime";
import { getEnvSafe } from "@/server/env";
import { getHelperStatus } from "@/server/update/helper-client";
import { pushConfigured } from "@/server/notifications/push";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;

  const env = getEnvSafe();
  const helper = await getHelperStatus().catch(() => null);
  const push = pushConfigured();
  const unraidUrl = resolveUnraidUrl();
  const apiKey = resolveUnraidApiKey();
  const prometheus = resolvePrometheusUrl();
  const authMode = resolveAuthMode();

  const settings = [
    { key: "unraid.url", label: "Unraid API URL", category: "Unraid", value: unraidUrl.value || null, source: unraidUrl.source, secret: false, editable: unraidUrl.source !== "env", restartRequired: false, testable: true },
    { key: "unraid.apiKey", label: "Unraid API key", category: "Unraid", value: apiKey.value ? "••••••••" : null, source: apiKey.source, secret: true, editable: apiKey.source !== "env", restartRequired: false, testable: false },
    { key: "prometheus.url", label: "Prometheus URL", category: "Metrics", value: prometheus.value || null, source: prometheus.source, secret: false, editable: prometheus.source !== "env", restartRequired: false, testable: true },
    { key: "helper.url", label: "Update helper", category: "Helper", value: helper?.configured ? "configured" : null, source: "env" as const, secret: false, editable: false, restartRequired: false, testable: false },
    { key: "notifications.vapid", label: "Push notifications (VAPID)", category: "Notifications", value: push.configured ? "configured" : null, source: "env" as const, secret: false, editable: false, restartRequired: false, testable: false },
    { key: "security.mode", label: "Authentication mode", category: "Networking / Advanced", value: authMode.mode, source: authMode.source, secret: false, editable: authMode.source !== "env", restartRequired: false, testable: false },
  ];

  return NextResponse.json({ settings }, { headers: { "cache-control": "no-store" } });
}
