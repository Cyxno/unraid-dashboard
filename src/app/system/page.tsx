"use client";

import { Activity, Thermometer } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { PAGE_INTERVAL_MS, usePrefs } from "@/lib/prefs";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { SectionStatus } from "@/components/dashboard/section-status";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes, formatPercent, formatTemp, formatUptime } from "@/lib/utils";
import { useOverview } from "@/components/layout/overview-provider";
import type { Section, SystemInfo } from "@/lib/api-types";

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b py-2 last:border-0">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right text-sm font-medium">{value}</dd>
    </div>
  );
}

export default function SystemPage() {
  const { data, error, loading } = usePoll<Section<SystemInfo>>(
    "/api/system",
    PAGE_INTERVAL_MS.system,
  );
  const { prefs } = usePrefs();
  const overview = useOverview();
  const info = data?.data ?? null;
  const temperature = info?.temperature ?? overview.data?.temperature.data ?? null;

  return (
    <div>
      <PageHeader
        title="System"
        description="Platform and hardware information"
        actions={
          <SectionStatus
            section={
              data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }
            }
          />
        }
      />

      {error && !data && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        >
          System data unavailable: {error}
        </p>
      )}

      {loading && !data ? (
        <LoadingPanel rows={8} />
      ) : info ? (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Operating system</CardTitle>
              <SectionStatus section={data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }} />
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Hostname" value={info.hostname ?? "—"} />
                <Row label="OS" value={info.distro ?? "—"} />
                <Row label="Version" value={overview.data?.identity.data?.osVersion ? `v${overview.data.identity.data.osVersion}` : "—"} />
                <Row label="Kernel" value={info.kernel ?? "—"} />
                <Row label="Architecture" value={info.arch ?? "—"} />
                <Row label="Boot mode" value={info.uefi === null ? "—" : info.uefi ? "UEFI" : "Legacy BIOS"} />
                <Row label="Uptime" value={formatUptime(overview.data?.identity.data?.uptimeSeconds)} />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>CPU &amp; memory</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Processor" value={info.cpuBrand ?? "—"} />
                <Row
                  label="Cores / threads"
                  value={
                    info.cpuCores
                      ? `${info.cpuCores} / ${info.cpuThreads ?? "—"}`
                      : "—"
                  }
                />
                <Row
                  label="Clock"
                  value={info.cpuSpeedGhz ? `${info.cpuSpeedGhz.toFixed(2)} GHz` : "—"}
                />
                <Row
                  label="Utilization"
                  value={formatPercent(overview.data?.cpu.data?.percentTotal)}
                />
                <Row label="Memory total" value={formatBytes(info.memoryTotalBytes)} />
                <Row
                  label="Memory used"
                  value={`${formatBytes(info.memoryUsedBytes)} (${formatPercent(overview.data?.memory.data?.percentTotal)})`}
                />
                <Row
                  label="Temperature"
                  value={
                    temperature && temperature.cpuC !== null ? (
                      <span className="inline-flex items-center gap-1">
                        <Thermometer className="size-3.5 text-muted-foreground" aria-hidden="true" />
                        {formatTemp(temperature.cpuC, prefs.tempUnit)}
                        {temperature.warningCount + temperature.criticalCount > 0 &&
                          ` · ${temperature.warningCount + temperature.criticalCount} over threshold`}
                      </span>
                    ) : (
                      "—"
                    )
                  }
                />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Motherboard</CardTitle>
            </CardHeader>
            <CardContent>
              <dl>
                <Row label="Board" value={info.boardModel ?? "—"} />
                <Row label="Manufacturer" value={info.boardManufacturer ?? "—"} />
                <Row label="System" value={info.systemModel ?? "—"} />
                <Row label="System vendor" value={info.systemManufacturer ?? "—"} />
                <Row
                  label="Virtualized"
                  value={info.virtualized === null ? "—" : info.virtualized ? "Yes" : "No (bare metal)"}
                />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>
                <span className="flex items-center gap-2">
                  <Activity className="size-4 text-muted-foreground" aria-hidden="true" />
                  Notes
                </span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                CPU and memory utilization update continuously on the overview
                page; this page refreshes every{" "}
                {PAGE_INTERVAL_MS.system / 1000}s.
              </p>
              <p>
                BIOS/firmware details and per-dimm memory population are not
                exposed by the current Unraid GraphQL API.
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">System information unavailable.</p>
      )}
    </div>
  );
}
