"use client";

import { KeyRound, Plug, RotateCcw } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import {
  PAGE_INTERVAL_MS,
  REFRESH_INTERVAL_MS,
  usePrefs,
  type Density,
  type HistoryWindowPref,
  type RefreshPreset,
  type TempUnit,
} from "@/lib/prefs";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { SectionStatus } from "@/components/dashboard/section-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTimeIso } from "@/lib/utils";
import { useOverview } from "@/components/layout/overview-provider";
import type { ConnectionStatus } from "@/lib/api-types";

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
    <div className="flex items-center justify-between gap-4 border-b py-3 last:border-0">
      <span className="text-sm">{label}</span>
      <div role="group" aria-label={label} className="flex items-center gap-1">
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
        <Card>
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
              ]}
            />
            <Choice<"hide" | "show">
              label="Show virtual network interfaces"
              value={prefs.showVirtualIfaces ? "show" : "hide"}
              onChange={(value) => setPref("showVirtualIfaces", value === "show")}
              options={[
                { value: "hide", label: "Hide" },
                { value: "show", label: "Show" },
              ]}
            />
            <div className="pt-3">
              <Button variant="outline" size="sm" onClick={reset}>
                <RotateCcw aria-hidden="true" /> Reset to defaults
              </Button>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-3">
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
                the browser. These settings contain appearance preferences only.
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
