"use client";

import { useEffect, useState } from "react";
import { KeyRound, Plug, RotateCcw, ShieldCheck, Stethoscope } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { usePwa } from "@/components/layout/pwa-provider";
import { getLastAuthAliveAt, isAuthExpired, onAuthChange } from "@/lib/auth-state";
import {
  PAGE_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  usePrefs,
  type Density,
  type HistoryWindowPref,
  type RefreshPreset,
  type TempUnit,
} from "@/lib/prefs";
import {
  formatBytes,
  formatDateTimeIso,
  formatUptime,
} from "@/lib/utils";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { SectionStatus } from "@/components/dashboard/section-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useOverview } from "@/components/layout/overview-provider";
import { InstallHint } from "@/components/layout/pwa-status-banner";
import { DashboardsSection } from "@/components/settings/dashboards-section";
import { UpdatesSection } from "@/components/settings/updates-section";
import type {
  BuildInfoDto,
  ConnectionStatus,
  DiagnosticsPayload,
} from "@/lib/api-types";

function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b py-3 last:border-0">
      <span className="text-sm">{label}</span>
      <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
        {options.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant={value === option.value ? "secondary" : "ghost"}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className="h-7 px-2.5 text-xs"
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-4 border-b py-3 last:border-0">
      <span className="text-sm">{label}</span>
      <input
        type="checkbox"
        checked={value}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-[var(--color-primary)]"
      />
    </label>
  );
}

/* About + diagnostics ------------------------------------------------------- */

interface UpdateStatusPayload {
  current: string;
  gitSha: string | null;
  buildTime: string | null;
  imageRef: string | null;
  update: {
    status: "up-to-date" | "available" | "unknown";
    reason?: string;
    latestTag: string | null;
    latestManifestDigest: string | null;
    latestRevisionSha: string | null;
    registry: {
      tokenConfigured: boolean;
      reachable: boolean | null;
      authorized: boolean | null;
      reason: string | null;
    };
  };
}

function DiagnosticsRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 text-xs">{children}</dd>
    </div>
  );
}

function AboutAndDiagnostics() {
  const version = usePoll<UpdateStatusPayload>("/api/update-check", 300_000);
  const diagnostics = usePoll<DiagnosticsPayload>(
    "/api/diagnostics",
    PAGE_INTERVAL_MS.connection,
  );
  const diag = diagnostics.data;
  const update = version.data?.update;
  const pwa = usePwa();

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Stethoscope className="size-4 text-muted-foreground" aria-hidden="true" />
            Diagnostics
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-1 text-sm">
          {diagnostics.loading && !diag ? (
            <LoadingPanel rows={3} />
          ) : diag ? (
            <dl className="space-y-2">
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">Unraid API</dt>
                <dd className="flex items-center gap-2">
                  <Badge variant={diag.sources.unraid.reachable ? "success" : "destructive"}>
                    {diag.sources.unraid.reachable ? "reachable" : "unreachable"}
                  </Badge>
                  <span className="font-mono text-xs">
                    {diag.sources.unraid.latencyMs != null
                      ? `${diag.sources.unraid.latencyMs} ms`
                      : "—"}
                  </span>
                </dd>
              </div>
              <div className="flex items-center justify-between gap-4">
                <dt className="text-muted-foreground">Prometheus</dt>
                <dd className="flex items-center gap-2">
                  {!diag.sources.prometheus.configured ? (
                    <Badge variant="muted">not configured</Badge>
                  ) : (
                    <Badge
                      variant={diag.sources.prometheus.reachable ? "success" : "destructive"}
                    >
                      {diag.sources.prometheus.reachable ? "reachable" : "unreachable"}
                    </Badge>
                  )}
                  <span className="font-mono text-xs">
                    {diag.sources.prometheus.latencyMs != null
                      ? `${diag.sources.prometheus.latencyMs} ms`
                      : "—"}
                  </span>
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Last Unraid success</dt>
                <dd className="text-xs">
                  {formatDateTimeIso(
                    diag.sections.metrics ?? diag.sources.unraid.lastSuccessAt,
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Last Prometheus success</dt>
                <dd className="text-xs">
                  {formatDateTimeIso(
                    diag.sections["history:cpu"] ?? diag.sources.prometheus.lastSuccessAt,
                  )}
                </dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Generated</dt>
                <dd className="text-xs">{formatDateTimeIso(diag.generatedAt)}</dd>
              </div>

              {/* PWA + browser state (client-side) */}
              <div className="border-t pt-2">
                <DiagnosticsRow label="Service worker">
                  <Badge variant={pwa.sw === "ready" ? "success" : pwa.sw === "unsupported" ? "muted" : "warning"}>
                    {pwa.sw}
                  </Badge>
                  {pwa.updateReady && <Badge variant="warning">update ready</Badge>}
                </DiagnosticsRow>
                <DiagnosticsRow label="App mode">
                  <Badge variant={pwa.standalone ? "success" : "muted"}>
                    {pwa.standalone ? "standalone (installed)" : "browser tab"}
                  </Badge>
                </DiagnosticsRow>
                <DiagnosticsRow label="Network">
                  <Badge variant={pwa.online ? "success" : "destructive"}>
                    {pwa.online ? "online" : "offline"}
                  </Badge>
                </DiagnosticsRow>
              </div>

              {/* Server self-monitoring + persistence (v0.6) */}
              {diag?.self && (
                <div className="border-t pt-2">
                  <DiagnosticsRow label="Dashboard CPU">
                    <span className="font-mono">
                      {diag.self.cpuPercent != null ? `${diag.self.cpuPercent}%` : "—"}
                    </span>
                  </DiagnosticsRow>
                  <DiagnosticsRow label="Dashboard memory">
                    <span className="font-mono">{formatBytes(diag.self.memoryRssBytes)}</span>
                  </DiagnosticsRow>
                  <DiagnosticsRow label="Dashboard uptime">
                    <span className="font-mono">{formatUptime(diag.self.uptimeSeconds)}</span>
                  </DiagnosticsRow>
                  <DiagnosticsRow label="SSE">
                    <span className="font-mono">
                      {diag.self.sseSubscribers} subscriber(s) · sampler{" "}
                      {diag.self.sseSamplerRunning ? "running" : "idle"}
                    </span>
                  </DiagnosticsRow>
                  <DiagnosticsRow label="Audit log">
                    <span className="font-mono">
                      {diag.self.audit.fileBytes != null
                        ? `${formatBytes(diag.self.audit.fileBytes, 0)}`
                        : "no file yet"}
                    </span>
                    <Badge variant={diag.self.audit.writable ? "success" : "destructive"}>
                      {diag.self.audit.writable ? "writable" : "read-only"}
                    </Badge>
                  </DiagnosticsRow>
                  <DiagnosticsRow label="Shared dashboards">
                    <span className="font-mono">{diag.self.dashboards.count} stored</span>
                    <Badge variant={diag.self.dashboards.writable ? "success" : "destructive"}>
                      {diag.self.dashboards.writable ? "writable" : "read-only"}
                    </Badge>
                  </DiagnosticsRow>
                  <DiagnosticsRow label="/app/data volume">
                    <Badge variant={diag.self.dataVolumeWritable ? "success" : "destructive"}>
                      {diag.self.dataVolumeWritable ? "persistent + writable" : "NOT writable"}
                    </Badge>
                    {diag.self.dataVolumeFreeBytes != null && (
                      <span className="font-mono">{formatBytes(diag.self.dataVolumeFreeBytes, 0)} free</span>
                    )}
                  </DiagnosticsRow>
                  {/* v0.7 additions */}
                  <DiagnosticsRow label="Auth mode">
                    <Badge variant={diag.self.authMode === "proxy" ? "success" : "muted"}>
                      {diag.self.authMode}
                    </Badge>
                  </DiagnosticsRow>
                  <DiagnosticsRow label="Dashboard schema">
                    <span className="font-mono">v{diag.self.dashboardSchemaVersion}</span>
                  </DiagnosticsRow>
                  <DiagnosticsRow label="Update helper">
                    {!diag.self.helper.configured ? (
                      <Badge variant="muted">not configured</Badge>
                    ) : diag.self.helper.reachable ? (
                      <Badge variant="success">
                        reachable{diag.self.helper.phase && diag.self.helper.phase !== "idle" ? ` (${diag.self.helper.phase})` : ""}
                      </Badge>
                    ) : (
                      <Badge variant="destructive">unreachable</Badge>
                    )}
                  </DiagnosticsRow>
                  <DiagnosticsRow label="Image digests">
                    <span className="font-mono text-[10px]">
                      running {diag.self.runningImageId ? diag.self.runningImageId.slice(7, 19) : "—"}
                      {" · "}GHCR {diag.self.ghcrDigest ? diag.self.ghcrDigest.slice(7, 19) : "—"}
                    </span>
                  </DiagnosticsRow>
                  {!diag.self.dataVolumeWritable && (
                    <p className="text-[11px] text-warning">
                      Persistence is degraded: the audit log and shared dashboards will not
                      survive container recreation. Mount a host directory at /app/data.
                    </p>
                  )}
                </div>
              )}
            </dl>
          ) : (
            <p className="text-muted-foreground">Diagnostics unavailable.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
        </CardHeader>
        <CardContent className="pt-1">
          {version.data ? (
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Version</dt>
                <dd className="font-mono text-xs">v{version.data.current}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Build</dt>
                <dd className="font-mono text-xs">
                  {version.data.gitSha
                    ? version.data.gitSha.slice(0, 7)
                    : "dev"}
                  {version.data.buildTime
                    ? ` · ${formatDateTimeIso(version.data.buildTime)}`
                    : ""}
                </dd>
              </div>
              {version.data.imageRef && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Image</dt>
                  <dd className="max-w-[220px] truncate font-mono text-xs" title={version.data.imageRef}>
                    {version.data.imageRef}
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Latest release</dt>
                <dd className="text-xs">
                  {update === undefined ? (
                    "…"
                  ) : update.status === "available" ? (
                    <Badge variant="warning">update available ({update.latestTag})</Badge>
                  ) : update.status === "up-to-date" ? (
                    <Badge variant="success">up to date</Badge>
                  ) : (
                    <span title={update.reason}>unknown</span>
                  )}
                </dd>
              </div>
              {update?.status === "available" && update.latestRevisionSha && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Available build</dt>
                  <dd className="font-mono text-xs">
                    {update.latestTag} · {update.latestRevisionSha.slice(0, 7)}
                  </dd>
                </div>
              )}
              {update?.latestManifestDigest && (
                <div className="flex justify-between gap-4">
                  <dt className="text-muted-foreground">Registry digest</dt>
                  <dd
                    className="max-w-[220px] truncate font-mono text-xs"
                    title={update.latestManifestDigest}
                  >
                    {update.latestManifestDigest.slice(0, 7 + 7)}…
                  </dd>
                </div>
              )}
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">GHCR check</dt>
                <dd className="text-xs">
                  {!update?.registry.tokenConfigured ? (
                    <span title="Set GHCR_TOKEN (read:packages) on the container to enable registry checks.">
                      not configured
                    </span>
                  ) : update.registry.authorized ? (
                    <Badge variant="success">registry reachable</Badge>
                  ) : (
                    <span title={update.registry.reason ?? undefined}>registry auth failed</span>
                  )}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="text-muted-foreground">Version information unavailable.</p>
          )}
          <div className="mt-3 border-t pt-3">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Install as app
            </p>
            <InstallHint />
          </div>
          <div className="mt-3 border-t pt-3">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              Update management
            </p>
            <div className="space-y-1 text-xs text-muted-foreground">
              <p>
                Updates are applied host-side with{" "}
                <code className="rounded bg-secondary px-1">scripts/update-dashboard.sh</code> — it
                recreates the container with identical configuration, health-checks the new image,
                and rolls back automatically on failure. The dashboard container itself never
                touches the Docker socket, so it cannot update itself.
              </p>
              {!update?.registry.tokenConfigured && (
                <p>
                  Registry status needs a server-side <code className="rounded bg-secondary px-1">GHCR_TOKEN</code>{" "}
                  (read:packages). Host pulls need a one-time{" "}
                  <code className="rounded bg-secondary px-1">scripts/login-ghcr.sh</code> login —
                  without it <code className="rounded bg-secondary px-1">docker pull</code> of new
                  releases fails with <em>unauthorized</em>.
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/* Security section ----------------------------------------------------------- */

interface AuthStatusPayload {
  mode: "disabled" | "proxy";
  user: string | null;
  actionsEnabled: boolean;
  actionsDisabledReason: string | null;
}

interface ActionsCapabilitiesPayload {
  enabled: boolean;
  reason: string | null;
  cooldownMs: number;
  ratePerMinute: number;
}

function SecuritySection() {
  const auth = usePoll<AuthStatusPayload>("/api/auth/status", 30_000);
  const actions = usePoll<ActionsCapabilitiesPayload>("/api/actions/status", 30_000);
  const authData = auth.data;
  const actionsData = actions.data;
  // Kiosk/session observability (v0.7.2): live session state + the last
  // successful authenticated request, tracked client-side (no tokens).
  const [sessionState, setSessionState] = useState<"active" | "expired">("active");
  const [lastAlive, setLastAlive] = useState<number | null>(null);
  useEffect(() => {
    setSessionState(isAuthExpired() ? "expired" : "active");
    return onAuthChange(() => {
      setSessionState(isAuthExpired() ? "expired" : "active");
      setLastAlive(getLastAuthAliveAt());
    });
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden="true" />
          Security
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-1 text-sm">
        {authData ? (
          <dl className="space-y-2">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Authentication</dt>
              <dd>
                {authData.mode === "proxy" ? (
                  <Badge variant="success">reverse proxy ({authData.user ?? "unidentified"})</Badge>
                ) : (
                  <Badge variant="muted" className="max-w-[220px] gap-1 whitespace-normal text-left" title="Requests are not authenticated; the dashboard trusts the LAN. Put it behind a reverse proxy with AUTH_MODE=proxy for identity.">
                    disabled — trusted network mode
                  </Badge>
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Session</dt>
              <dd className="flex items-center gap-2 text-xs">
                <Badge variant={sessionState === "active" ? "success" : "destructive"}>
                  {sessionState}
                </Badge>
                {lastAlive && (
                  <span className="text-muted-foreground">
                    last authed request {Math.max(0, Math.round((Date.now() - lastAlive) / 1000))}s ago
                  </span>
                )}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">Write actions</dt>
              <dd>
                {actionsData?.enabled ? (
                  <Badge variant="warning">enabled</Badge>
                ) : (
                  <Badge variant="secondary">disabled</Badge>
                )}
              </dd>
            </div>
            {actionsData && !actionsData.enabled && actionsData.reason && (
              <p className="text-[11px] text-muted-foreground">{actionsData.reason}</p>
            )}
            {actionsData?.enabled && (
              <div className="flex justify-between gap-4">
                <dt className="text-muted-foreground">Guards</dt>
                <dd className="text-xs">
                  cooldown {Math.round(actionsData.cooldownMs / 1000)}s · max{" "}
                  {actionsData.ratePerMinute}/min · audit logged
                </dd>
              </div>
            )}
          </dl>
        ) : (
          <p className="text-muted-foreground">Security status unavailable.</p>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { prefs, setPref, reset } = usePrefs();
  const overview = useOverview();
  const connection = usePoll<ConnectionStatus>(
    "/api/connection",
    PAGE_INTERVAL_MS.connection,
  );

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Dashboard-local preferences (stored in this browser)"
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>Display &amp; refresh</CardTitle>
          </CardHeader>
          <CardContent className="pt-1">
            <Choice<RefreshPreset>
              label="Refresh speed"
              value={prefs.refresh}
              onChange={(value) => setPref("refresh", value)}
              options={[
                { value: "fast", label: `Fast (${REFRESH_INTERVAL_MS.fast / 1000}s)` },
                { value: "normal", label: `Normal (${REFRESH_INTERVAL_MS.normal / 1000}s)` },
                { value: "relaxed", label: `Relaxed (${REFRESH_INTERVAL_MS.relaxed / 1000}s)` },
              ]}
            />
            <Choice<TempUnit>
              label="Temperature unit"
              value={prefs.tempUnit}
              onChange={(value) => setPref("tempUnit", value)}
              options={[
                { value: "C", label: "°C" },
                { value: "F", label: "°F" },
              ]}
            />
            <Choice<Density>
              label="Table density"
              value={prefs.density}
              onChange={(value) => setPref("density", value)}
              options={[
                { value: "comfortable", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
            />
            <Choice<HistoryWindowPref>
              label="Default history window"
              value={prefs.historyWindow}
              onChange={(value) => setPref("historyWindow", value)}
              options={[
                { value: "5m", label: "5 min" },
                { value: "15m", label: "15 min" },
                { value: "1h", label: "1 hour" },
                { value: "6h", label: "6 hours" },
                { value: "24h", label: "24 hours" },
                { value: "7d", label: "7 days" },
              ]}
            />
            <Toggle
              label="Show per-core CPU (System page)"
              value={prefs.showPerCore}
              onChange={(value) => setPref("showPerCore", value)}
            />
            <Toggle
              label="Show Docker metric columns"
              value={prefs.dockerMetrics}
              onChange={(value) => setPref("dockerMetrics", value)}
            />
            <Toggle
              label="Show virtual network interfaces"
              value={prefs.showVirtualIfaces}
              onChange={(value) => setPref("showVirtualIfaces", value)}
            />
            <div className="pt-3">
              <Button variant="outline" size="sm" onClick={reset}>
                <RotateCcw aria-hidden="true" /> Reset to defaults
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Plug className="size-4 text-muted-foreground" aria-hidden="true" />
                Server connection
              </CardTitle>
              <SectionStatus
                section={
                  overview.data
                    ? { status: "live", data: overview.data, fetchedAt: "", ageMs: 0 }
                    : { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }
                }
                compact
              />
            </CardHeader>
            <CardContent className="pt-1 text-sm">
              {connection.loading && !connection.data ? (
                <LoadingPanel rows={2} />
              ) : connection.data ? (
                <dl className="space-y-2">
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Target</dt>
                    <dd className="font-mono text-xs">
                      {connection.data.targetHost}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Reachable</dt>
                    <dd>
                      <Badge variant={connection.data.reachable ? "success" : "destructive"}>
                        {connection.data.reachable ? "yes" : "no"}
                      </Badge>
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Response latency</dt>
                    <dd className="font-mono text-xs">
                      {connection.data.latencyMs != null
                        ? `${connection.data.latencyMs} ms`
                        : "—"}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">API key roles</dt>
                    <dd className="flex gap-1">
                      {connection.data.roles.length > 0 ? (
                        connection.data.roles.map((role) => (
                          <Badge key={role} variant="muted">
                            {role}
                          </Badge>
                        ))
                      ) : (
                        "—"
                      )}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-4">
                    <dt className="text-muted-foreground">Last successful fetch</dt>
                    <dd className="text-xs">
                      {formatDateTimeIso(connection.data.lastSuccessAt)}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="text-muted-foreground">Connection status unavailable.</p>
              )}
            </CardContent>
          </Card>

          <SecuritySection />

          <UpdatesSection />

          <DashboardsSection />

          <AboutAndDiagnostics />

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="size-4 text-muted-foreground" aria-hidden="true" />
                Security model
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                The Unraid API key is configured server-side and never sent to
                the browser. Prometheus is queried server-side too; the browser
                can never run arbitrary PromQL. These settings contain
                appearance preferences only.
              </p>
              <p>
                The dashboard uses a read-only (VIEWER) API key; no write or
                lifecycle actions are exposed anywhere in the UI.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
