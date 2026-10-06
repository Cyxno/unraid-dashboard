"use client";

import { useCallback, useEffect, useState } from "react";
import { Bell, BellOff, CheckCircle2, Loader2, RefreshCw, Send, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { usePwa } from "@/components/layout/pwa-provider";
import { cn, formatDateTimeIso } from "@/lib/utils";
import { derivePermissionPresentation, evaluatePushSupport, isAppleMobile, isStandalone } from "@/lib/push-support";
import {
  diagnoseDevice,
  diagnosticsIndicateRepair,
  enablePush,
  ensureActiveWorker,
  type DevicePushDiagnostics,
  type PushRegistrationLike,
} from "@/lib/push-client";

/**
 * Notification settings (v1.2.0): permission UX, delivery preferences,
 * subscribed devices, recent history and a real test notification.
 *
 * Permission is NEVER requested on page load — only from the explicit
 * "Enable notifications" click. Without server-side VAPID keys the push
 * section renders as "not configured" and everything else keeps working.
 */

interface NotificationConfig {
  push: { configured: boolean; publicKey: string | null };
  preferences: {
    master: boolean;
    severities: { critical: boolean; warning: boolean; info: boolean };
    categories: Record<string, boolean>;
  };
  subscriptions: Array<{
    label: string;
    endpointTail: string;
    createdAt: string;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    enabled: boolean;
  }>;
}

interface HistoryEvent {
  id: number;
  severity: string;
  category: string;
  title: string;
  body: string;
  source: string;
  url: string;
  occurredAt: string;
  kind: string;
  delivery: string;
  detail: string | null;
}

const CATEGORY_LABELS: Record<string, string> = {
  "system-health": "System health",
  "docker-health": "Docker health",
  "docker-updates": "Docker updates",
  storage: "Storage",
  "beacon-updates": "Beacon updates",
  services: "Service & integration warnings",
  resolved: "Resolved / recovery events",
};

const SEVERITY_LABELS: Record<string, string> = {
  critical: "Critical",
  warning: "Warning",
  info: "Info",
};


const DELIVERY_LABELS: Record<string, { label: string; tone: "success" | "error" | "muted" }> = {
  pushed: { label: "Delivered", tone: "success" },
  "in-app": { label: "Delivered in-app", tone: "success" },
  "skipped-preference": { label: "Skipped (preference)", tone: "muted" },
  "skipped-unconfigured": { label: "Skipped (not configured)", tone: "muted" },
  failed: { label: "Failed", tone: "error" },
};

const CATEGORY_SHORT: Record<string, string> = {
  "system-health": "System health",
  "docker-health": "Docker health",
  "docker-updates": "Docker updates",
  storage: "Storage",
  "beacon-updates": "Beacon updates",
  services: "Services",
  resolved: "Resolved",
};

export function NotificationsSection() {
  const { online } = usePwa();
  const [config, setConfig] = useState<NotificationConfig | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const [, setSupport] = useState<{ kind: string; installed: boolean } | null>(null);
  const [presentation, setPresentation] = useState<ReturnType<typeof derivePermissionPresentation> | null>(null);
  const [, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<"subscribe" | "unsubscribe" | "test" | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [deviceDiag, setDeviceDiag] = useState<DevicePushDiagnostics | null>(null);

  // Fase 3/16 (v1.3.19): device-specific push diagnostics — which worker owns
  // push, is a subscription present, and does the server know it.
  const loadDiagnostics = useCallback(async () => {
    if (!("serviceWorker" in navigator)) return;
    try {
      setDeviceDiag(await diagnoseDevice(
        { serviceWorker: async () => {
            const registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
            return registration as unknown as PushRegistrationLike;
          } },
        { listServerSubscriptions: async () => {
            const response = await fetch("/api/notifications/config", { cache: "no-store" });
            if (!response.ok) throw new Error("config unavailable");
            const body = (await response.json()) as { subscriptions?: Array<{ endpointTail: string; enabled: boolean }> };
            return body.subscriptions ?? [];
          } },
      ));
    } catch {
      setDeviceDiag(null);
    }
  }, []);
  const [history, setHistory] = useState<HistoryEvent[]>([]);

  const loadConfig = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications/config", { cache: "no-store" });
      if (response.ok) setConfig((await response.json()) as NotificationConfig);
    } catch {
      // Offline — keep the last known config.
    }
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/notifications/history?limit=25", { cache: "no-store" });
      if (response.ok) setHistory(((await response.json()) as { events: HistoryEvent[] }).events ?? []);
    } catch {
      // Offline.
    }
  }, []);

  const refreshSubscriptionState = useCallback(async () => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setSubscribed(false);
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      setSubscribed(Boolean(existing));
    } catch {
      setSubscribed(false);
    }
  }, []);

  useEffect(() => {
    // Permission state after paint: browser APIs are read post-mount and
    // the setState lands outside the effect body (react-hooks rule).
    const frame = window.requestAnimationFrame(() => {
      setPermission(typeof Notification === "undefined" ? "unsupported" : Notification.permission);
      const userAgent = navigator.userAgent;
      const supportValue = evaluatePushSupport({
        hasNotificationApi: typeof Notification !== "undefined",
        hasPushManager: "PushManager" in window,
        hasServiceWorker: "serviceWorker" in navigator,
        secureContext: window.isSecureContext,
        isAppleMobile: isAppleMobile(userAgent, navigator.maxTouchPoints ?? 0),
        standalone: isStandalone(),
      });
      setSupport(supportValue);
      const browserPermission = typeof Notification === "undefined" ? ("unsupported" as const) : Notification.permission;
      const presentationValue = derivePermissionPresentation({ permission: browserPermission, supportKind: supportValue.kind });
      setPresentation(presentationValue);
      // Diagnostic capability payload (development only, no secrets).
      if (process.env.NODE_ENV !== "production") {
        void Promise.resolve().then(async () => {
          let subscriptionPresent: boolean | null = null;
          try {
            if ("serviceWorker" in navigator) {
              const reg = await navigator.serviceWorker.getRegistration();
              subscriptionPresent = Boolean(await reg?.pushManager.getSubscription());
            }
          } catch {
            subscriptionPresent = null;
          }
          console.info("[notifications] capability", {
            notificationPermission: browserPermission,
            secureContext: window.isSecureContext,
            serviceWorkerSupported: "serviceWorker" in navigator,
            pushManagerSupported: "PushManager" in window,
            standalone: supportValue.installed,
            vapidConfigured: config?.push.configured ?? null,
            subscriptionPresent,
            derivedState: presentationValue.badge,
          });
        });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    // Deferred to a macrotask: the loader callbacks settle state outside
    // the effect body (react-hooks set-state-in-effect rule).
    const timer = setTimeout(() => {
      void loadConfig();
      void loadHistory();
      void refreshSubscriptionState();
    }, 0);
    return () => clearTimeout(timer);
  }, [loadConfig, loadHistory, refreshSubscriptionState]);

  const enableNotifications = async (mode: "enable" | "repair" = "enable") => {
    setBusy("subscribe");
    setNotice(null);
    try {
      if (typeof Notification === "undefined") {
        setNotice({ tone: "error", text: "This browser does not support notifications." });
        return;
      }
      const permission = await Notification.requestPermission();
      setPermission(permission);
      if (permission !== "granted") {
        setNotice({
          tone: "error",
          text:
            permission === "denied"
              ? "Notifications are blocked for this site. Re-enable them in your browser&apos;s site settings (padlock icon → Notifications)."
              : "Permission was dismissed — click Enable again to ask the browser.",
        });
        return;
      }
      if (!config?.push.configured || !config.push.publicKey) {
        setNotice({ tone: "success", text: "Browser notifications enabled. Server push is not configured (VAPID keys missing), so notifications only work while a Beacon tab is open." });
        try {
          window.localStorage.setItem("beacon.notifications.pushConfigured", "0");
        } catch {}
        return;
      }
      // v1.3.19: the enable pipeline lives in the tested push-client module —
      // explicit /sw.js registration (never navigator.serviceWorker.ready),
      // validated VAPID decoding and categorized outcomes.
      // v1.3.21: ensure the ACTIVE worker is the current build before (re)subscribing —
      // a subscription bound to an old waiting worker never sees background push.
      const registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
      await ensureActiveWorker(registration as unknown as Parameters<typeof ensureActiveWorker>[0]);
      const outcome = await enablePush(
        {
          permission: () => Notification.permission,
          requestPermission: () => Notification.requestPermission(),
          serviceWorker: async () => registration as unknown as PushRegistrationLike,
        },
        {
          vapidPublicKey: async () => config.push.publicKey,
          registerSubscription: async (subscription: { endpoint: string; keys: { p256dh: string; auth: string } }) => {
            const response = await fetch("/api/notifications/subscriptions", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ endpoint: subscription.endpoint, keys: subscription.keys }),
            });
            if (!response.ok) throw new Error(`Subscription failed (HTTP ${response.status})`);
          },
          listServerSubscriptions: async () => [],
        },
        { recreate: mode === "repair" },
      );
      if (!outcome.ok) {
        setNotice({ tone: "error", text: `Push could not be enabled (${outcome.kind}).` });
        return;
      }
      try {
        window.localStorage.setItem("beacon.notifications.pushConfigured", "1");
      } catch {}
      await refreshSubscriptionState();
      await loadDiagnostics();
      void loadConfig();
      setNotice({ tone: "success", text: "Push notifications enabled for this device." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Enabling notifications failed." });
    } finally {
      setBusy(null);
    }
  };

  const disableNotifications = async () => {
    setBusy("unsubscribe");
    setNotice(null);
    try {
      if ("serviceWorker" in navigator && "PushManager" in window) {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (existing) {
          await existing.unsubscribe();
          await fetch("/api/notifications/subscriptions", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ endpoint: existing.endpoint }),
          });
        }
      }
      try {
        window.localStorage.setItem("beacon.notifications.pushConfigured", "0");
      } catch {}
      await refreshSubscriptionState();
      void loadConfig();
      setNotice({ tone: "success", text: "Push notifications disabled for this device." });
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Disabling failed." });
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy("test");
    setNotice(null);
    try {
      const response = await fetch("/api/notifications/test", { method: "POST", headers: { "content-type": "application/json" } });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; delivery?: string; detail?: string | null; error?: string } | null;
      if (!response.ok || !body?.ok) {
        setNotice({ tone: "error", text: body?.detail ?? body?.error ?? `Test failed (HTTP ${response.status}).` });
      } else if (body.delivery === "pushed") {
        setNotice({ tone: "success", text: "Test notification pushed to all subscribed devices." });
      } else {
        setNotice({ tone: "success", text: `Test notification delivered in-app (${body.detail ?? body.delivery}).` });
      }
      void loadHistory();
    } catch (error) {
      setNotice({ tone: "error", text: error instanceof Error ? error.message : "Test failed." });
    } finally {
      setBusy(null);
    }
  };

  const savePreference = async (patch: Record<string, unknown>) => {
    if (!config) return;
    const optimistic = {
      ...config,
      preferences: deepMerge(config.preferences, patch),
    };
    setConfig(optimistic);
    try {
      const response = await fetch("/api/notifications/preferences", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(optimistic.preferences),
      });
      if (!response.ok) throw new Error("Saving preferences failed.");
    } catch {
      void loadConfig();
    }
  };

  const badgeFor: Record<string, { variant: "muted" | "success" | "destructive" | "warning"; label: string }> = {
    granted: { variant: "success", label: "granted" },
    blocked: { variant: "destructive", label: "blocked" },
    "not-asked": { variant: "muted", label: "not asked" },
    "not-supported": { variant: "muted", label: "not supported" },
    "requires-https": { variant: "muted", label: "requires HTTPS" },
    "install-required": { variant: "warning", label: "home-screen install required" },
    "check-browser": { variant: "muted", label: "check browser" },
  };
  const permissionBadge = () => {
    if (!presentation) return <Badge variant="muted">checking…</Badge>;
    const meta = badgeFor[presentation.badge] ?? { variant: "muted" as const, label: presentation.badge };
    return <Badge variant={meta.variant}>{meta.label}</Badge>;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-4" aria-hidden="true" /> Notifications
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <p className="-mt-2 text-xs text-muted-foreground">
          Opt-in per browser/device. Critical and warning conditions come from Beacon&apos;s health
          semantics; stopped containers are never a notification.
        </p>
        {/* Permission / push capability */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wider text-muted-foreground">Browser permission</span>
          {permissionBadge()}
          {config && !config.push.configured && (
            <Badge variant="muted" title="Set BEACON_VAPID_PUBLIC_KEY / BEACON_VAPID_PRIVATE_KEY to enable push delivery">
              push not configured
            </Badge>
          )}
        </div>
        {deviceDiag && (
          <div className="rounded-md border bg-muted/30 p-3 text-xs" data-testid="push-device-diagnostics">
            <p className="mb-1.5 font-medium text-foreground">This device (push pipeline)</p>
            <ul className="grid grid-cols-1 gap-x-6 gap-y-0.5 sm:grid-cols-2">
              <li>Service worker: {deviceDiag.registrationExists ? (deviceDiag.active ? "active" : deviceDiag.installing ? "installing" : deviceDiag.waiting ? "waiting" : "registered") : "not registered"}</li>
              <li>Controller: {deviceDiag.controller ? "present" : "none"}</li>
              <li>Worker version: {deviceDiag.workerVersion ?? deviceDiag.activeScriptUrl?.split("/").pop() ?? "unknown"}</li>
              {deviceDiag.telemetry && (
                <li>
                  Push events received: {deviceDiag.telemetry.pushReceived}
                  {deviceDiag.telemetry.lastPushAt ? ` · last at ${deviceDiag.telemetry.lastPushAt}` : ""}
                  {deviceDiag.telemetry.lastShowResult === "error" ? ` · show failed (${deviceDiag.telemetry.lastShowErrorName})` : ""}
                </li>
              )}
              <li>Push subscription: {deviceDiag.subscriptionPresent ? "present on device" : "absent"}</li>
              <li>
                Server knows subscription:{" "}
                {deviceDiag.serverKnowsSubscription === null
                  ? "unknown"
                  : deviceDiag.serverKnowsSubscription
                    ? "yes (endpoint tail matches)"
                    : "NO — mismatch"}
              </li>
              <li>Server registered devices: {deviceDiag.serverHasNoDevices === null ? "unknown" : deviceDiag.serverHasNoDevices ? "none" : "≥1"}</li>
              <li>Secure context: {deviceDiag.secureContext ? "yes" : "no"}</li>
              <li>Standalone (installed PWA): {deviceDiag.standalone ? "yes" : "no"}</li>
            </ul>
            {(diagnosticsIndicateRepair(deviceDiag) || deviceDiag.waiting) && (
              <p className="mt-1.5 text-warning">
                {deviceDiag.waiting && "A newer service worker is waiting and will activate on the next reload. "}
                {diagnosticsIndicateRepair(deviceDiag) && "Use “Repair this device” to re-register the subscription."}
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="outline" disabled={!online || busy !== null} onClick={() => { void loadDiagnostics(); }}>
                Refresh diagnostics
              </Button>
              {presentation?.canEnable && (
                <Button size="sm" variant="outline" disabled={!online || busy !== null} onClick={() => void enableNotifications("repair")}>
                  {busy === "subscribe" ? "Repairing…" : "Repair this device"}
                </Button>
              )}
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {presentation?.canEnable && (
            <Button size="sm" disabled={!online || busy !== null} onClick={() => void enableNotifications()}>
              {busy === "subscribe" ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Bell className="size-3.5" aria-hidden="true" />}
              Enable notifications
            </Button>
          )}
          {permission === "granted" && (
            <Button size="sm" variant="outline" disabled={!online || busy !== null} onClick={() => void disableNotifications()}>
              {busy === "unsubscribe" ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <BellOff className="size-3.5" aria-hidden="true" />}
              Disable on this device
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={!online || busy !== null} onClick={() => void sendTest()}>
            {busy === "test" ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Send className="size-3.5" aria-hidden="true" />}
            Send test notification
          </Button>
        </div>
        {presentation?.message && (
          <p className="text-xs text-muted-foreground" role="status">
            {presentation.message}
          </p>
        )}
        {notice && (
          <p role="status" className={cn("text-xs", notice.tone === "success" ? "text-success" : "text-destructive")}>
            {notice.tone === "success" ? <CheckCircle2 className="mr-1 inline size-3.5" aria-hidden="true" /> : <XCircle className="mr-1 inline size-3.5" aria-hidden="true" />}
            {notice.text}
          </p>
        )}

        {/* Severity + category preferences */}
        {config && (
          <p className="text-xs text-muted-foreground">
            Preferences apply to this Beacon installation; delivery itself is opt-in per device (below).
          </p>
        )}
        {config && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Severity</p>
              <div className="space-y-1">
                {Object.entries(SEVERITY_LABELS).map(([key, label]) => (
                  <label key={key} className="flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)]"
                      checked={config.preferences.severities[key as keyof typeof config.preferences.severities]}
                      onChange={(event) =>
                        void savePreference({ severities: { ...config.preferences.severities, [key]: event.target.checked } })
                      }
                    />
                    {label}
                    {key === "info" && <span className="text-muted-foreground">(updates, recovery)</span>}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Categories</p>
              <div className="space-y-1">
                {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                  <label key={key} className="flex cursor-pointer items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      className="accent-[var(--primary)]"
                      checked={config.preferences.categories[key]}
                      onChange={(event) =>
                        void savePreference({ categories: { ...config.preferences.categories, [key]: event.target.checked } })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Devices */}
        {config && config.subscriptions.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">Subscribed devices</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {config.subscriptions.map((device) => (
                <li key={device.endpointTail} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-foreground">{device.label}</span>
                  <span className="font-mono">…{device.endpointTail}</span>
                  <span>since {formatDateTimeIso(device.createdAt)}</span>
                  {device.lastSuccessAt && <span>· last delivered {formatDateTimeIso(device.lastSuccessAt)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* History */}
        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">Recent history</p>
            <Button size="sm" variant="ghost" className="h-6 gap-1 text-xs" disabled={!online} onClick={() => void loadHistory()}>
              <RefreshCw className="size-3" aria-hidden="true" /> Refresh
            </Button>
          </div>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No notifications recorded yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {history.slice(0, 12).map((event) => (
                <li key={event.id} className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="w-36 shrink-0 text-muted-foreground">{formatDateTimeIso(event.occurredAt)}</span>
                  <Badge
                    variant={event.severity === "critical" ? "destructive" : event.severity === "warning" ? "warning" : "muted"}
                    className="text-[10px]"
                  >
                    {event.severity}
                  </Badge>
                  <span className="shrink-0 text-muted-foreground">{CATEGORY_SHORT[event.category] ?? event.category}</span>
                  <span className="min-w-0 flex-1 truncate">{event.title}</span>
                  <span
                    className={cn(
                      "shrink-0 text-[10px]",
                      (DELIVERY_LABELS[event.delivery] ?? { tone: "muted" }).tone === "success"
                        ? "text-success"
                        : (DELIVERY_LABELS[event.delivery] ?? { tone: "muted" }).tone === "error"
                          ? "text-destructive"
                          : "text-muted-foreground",
                    )}
                    title={event.detail ?? undefined}
                  >
                    {(DELIVERY_LABELS[event.delivery] ?? { label: event.delivery }).label}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function deepMerge<T>(base: T, patch: Record<string, unknown>): T {
  if (typeof base !== "object" || base === null || Array.isArray(base)) return base;
  const result = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch)) {
    result[key] =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? deepMerge(result[key], value as Record<string, unknown>)
        : value;
  }
  return result as T;
}
