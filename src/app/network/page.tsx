"use client";

import { Network } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { PAGE_INTERVAL_MS, usePrefs } from "@/lib/prefs";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { SectionStatus } from "@/components/dashboard/section-status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRate } from "@/lib/utils";
import type { NetworkInterfaceInfo, Section } from "@/lib/api-types";

export default function NetworkPage() {
  const { data, error, loading } = usePoll<Section<NetworkInterfaceInfo[]>>(
    "/api/network",
    PAGE_INTERVAL_MS.network,
  );
  const { prefs, setPref } = usePrefs();

  const interfaces = data?.data ?? [];
  const relevant = interfaces.filter((iface) => prefs.showVirtualIfaces || !iface.virtual);
  const virtualCount = interfaces.length - interfaces.filter((i) => !i.virtual).length;

  return (
    <div>
      <PageHeader
        title="Network"
        description="Interfaces and live throughput"
        actions={
          <SectionStatus
            section={
              data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }
            }
          />
        }
      />

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
                  <Badge variant={up ? "success" : "muted"}>{iface.operstate ?? "unknown"}</Badge>
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
                        {iface.totalReceivedBytes != null
                          ? `${(iface.totalReceivedBytes / 1024 ** 3).toFixed(1)} GB`
                          : "—"}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">Total TX</dt>
                      <dd className="font-mono text-xs tabular-nums">
                        {iface.totalSentBytes != null
                          ? `${(iface.totalSentBytes / 1024 ** 3).toFixed(1)} GB`
                          : "—"}
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
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
      <p className="mt-4 text-[11px] text-muted-foreground">
        Aggregate RX/TX on the overview page counts physical interfaces only, so
        bridge/veth traffic is never double-counted.
      </p>
    </div>
  );
}
