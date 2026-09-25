"use client";

import { Network } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import {
  HISTORY_INTERVAL_MS,
  PAGE_INTERVAL_MS,
  usePrefs,
  type HistoryWindowPref,
} from "@/lib/prefs";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { MetricStatus, SectionStatus } from "@/components/dashboard/section-status";
import { SeriesChart } from "@/components/dashboard/series-chart";
import { WindowPicker } from "@/components/dashboard/window-picker";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { formatBytes, formatRate } from "@/lib/utils";
import type {
  InterfaceHistoryPayload,
  NetworkInterfaceInfo,
  Section,
} from "@/lib/api-types";

export default function NetworkPage() {
  const { data, error, loading } = usePoll<Section<NetworkInterfaceInfo[]>>(
    "/api/network",
    PAGE_INTERVAL_MS.network,
  );
  const { prefs, setPref } = usePrefs();
  const [window, setWindow] = [prefs.historyWindow, (value: HistoryWindowPref) => setPref("historyWindow", value)];
  const history = usePoll<InterfaceHistoryPayload>(
    `/api/network/history?window=${window}`,
    HISTORY_INTERVAL_MS[window],
  );

  const interfaces = data?.data ?? [];
  const relevant = interfaces.filter(
    (iface) => prefs.showVirtualIfaces || !iface.virtual,
  );
  const virtualCount =
    interfaces.length - interfaces.filter((i) => !i.virtual).length;
  const historyUnavailable = history.data?.meta.status === "unavailable";

  /* Join Prometheus history throughput onto Unraid interface rows. */
  const historyByName = new Map(
    (history.data?.interfaces ?? []).map((entry) => [entry.name, entry]),
  );

  return (
    <div>
      <PageHeader
        title="Network"
        description="Interfaces, live throughput and history"
        actions={
          <SectionStatus
            section={
              data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }
            }
          />
        }
      />

      {/* Throughput history ---------------------------------------------- */}
      <Card className="mb-4">
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="mr-auto text-base">
              Throughput history
            </CardTitle>
            <WindowPicker value={window} onChange={setWindow} />
          </div>
          <MetricStatus meta={history.data?.meta ?? null} />
        </CardHeader>
        <CardContent>
          {history.loading && !history.data ? (
            <Skeleton className="h-[240px] w-full" />
          ) : historyUnavailable ? (
            <div className="flex h-[240px] items-center justify-center rounded-md border border-dashed px-6 text-center text-sm text-muted-foreground">
              Throughput history unavailable — Prometheus is unreachable.
            </div>
          ) : (
            <SeriesChart
              series={[
                {
                  name: "RX (all physical)",
                  points: mergeDirection(history.data?.interfaces ?? [], "rx"),
                },
                {
                  name: "TX (all physical)",
                  points: mergeDirection(history.data?.interfaces ?? [], "tx"),
                },
              ]}
              unit="rate"
            />
          )}
          <p className="mt-2 text-[11px] text-muted-foreground">
            Aggregates cover eth/br/tailscale interfaces only — docker bridges
            and veths are excluded so bytes are never double-counted.
            Per-interface series below mirror the same rule.
          </p>
        </CardContent>
      </Card>

      <div className="mb-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={prefs.showVirtualIfaces}
            onChange={(event) => setPref("showVirtualIfaces", event.target.checked)}
            className="size-4 accent-[var(--color-primary)]"
          />
          Show virtual interfaces
          {virtualCount > 0 && (
            <Badge variant="muted" className="text-[10px]">
              {virtualCount} hidden
            </Badge>
          )}
        </label>
      </div>

      {loading && interfaces.length === 0 ? (
        <LoadingPanel rows={4} />
      ) : error && !data ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        >
          Network data unavailable: {error}
        </p>
      ) : relevant.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          No interfaces reported.
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {relevant.map((iface) => {
            const up = iface.operstate === "up";
            const series = historyByName.get(iface.name);
            return (
              <Card key={iface.name}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 font-semibold text-foreground">
                    <Network className="size-4 text-muted-foreground" aria-hidden="true" />
                    {iface.name}
                    {iface.virtual && (
                      <Badge variant="muted" className="text-[10px]">
                        virtual
                      </Badge>
                    )}
                  </CardTitle>
                  <Badge variant={up ? "success" : "muted"}>
                    {iface.operstate ?? "unknown"}
                  </Badge>
                </CardHeader>
                <CardContent>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <dt className="text-xs text-muted-foreground">IPv4</dt>
                      <dd className="font-mono text-xs">{iface.ipAddress ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Speed</dt>
                      <dd className="font-mono text-xs">
                        {iface.speedMbps != null
                          ? iface.speedMbps >= 1000
                            ? `${(iface.speedMbps / 1000).toFixed(1)} Gb/s`
                            : `${iface.speedMbps} Mb/s`
                          : "—"}
                        {iface.duplex && iface.duplex !== "unknown"
                          ? ` · ${iface.duplex}`
                          : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">RX rate</dt>
                      <dd className="font-mono text-xs tabular-nums">
                        {formatRate(iface.rxBytesPerSec)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">TX rate</dt>
                      <dd className="font-mono text-xs tabular-nums">
                        {formatRate(iface.txBytesPerSec)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Total RX</dt>
                      <dd className="font-mono text-xs tabular-nums">
                        {formatBytes(iface.totalReceivedBytes)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Total TX</dt>
                      <dd className="font-mono text-xs tabular-nums">
                        {formatBytes(iface.totalSentBytes)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">MAC</dt>
                      <dd className="font-mono text-xs">{iface.macAddress ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">DHCP</dt>
                      <dd className="text-xs">
                        {iface.useDhcp === null ? "—" : iface.useDhcp ? "Yes" : "No"}
                      </dd>
                    </div>
                  </dl>
                  {series && series.rxPoints.length >= 2 && (
                    <div className="mt-3">
                      <SeriesChart
                        series={[
                          { name: "RX", points: series.rxPoints },
                          { name: "TX", points: series.txPoints },
                        ]}
                        unit="rate"
                        height={120}
                      />
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-[11px] text-muted-foreground">
        Aggregate RX/TX on the overview page counts physical interfaces only, so
        bridge/veth traffic is never double-counted. Cumulative counters reset
        when the host reboots.
      </p>
    </div>
  );
}

/** Point-wise sum of every interface's rx or tx history. */
function mergeDirection(
  interfaces: NonNullable<InterfaceHistoryPayload["interfaces"]>[number][],
  direction: "rx" | "tx",
) {
  const perTime = new Map<number, number | null>();
  for (const iface of interfaces) {
    const points = direction === "rx" ? iface.rxPoints : iface.txPoints;
    for (const point of points) {
      const existing = perTime.get(point.t);
      if (point.v === null) {
        perTime.set(point.t, existing ?? null);
      } else {
        perTime.set(point.t, (existing ?? 0) + point.v);
      }
    }
  }
  return [...perTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, v]) => ({ t, v }));
}
