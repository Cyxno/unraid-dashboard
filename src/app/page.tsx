"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Boxes,
  Clock,
  Cpu,
  HardDrive,
  MemoryStick,
  Thermometer,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { usePoll } from "@/hooks/use-poll";
import { useOverview } from "@/components/layout/overview-provider";
import { MetricCard, MetricCardSkeleton } from "@/components/dashboard/metric-card";
import { HeroStrip, HeroStripSkeleton } from "@/components/dashboard/hero-strip";
import { SeriesChart } from "@/components/dashboard/series-chart";
import { WindowPicker } from "@/components/dashboard/window-picker";
import { TopConsumersCard } from "@/components/dashboard/top-consumers";
import { StorageOverview } from "@/components/dashboard/storage-overview";
import { DockerOverviewList } from "@/components/dashboard/docker-overview-list";
import { NotificationsCard } from "@/components/dashboard/notifications-card";
import { MetricStatus } from "@/components/dashboard/section-status";
import { PageStack, SectionStack } from "@/components/dashboard/layout-primitives";
import { Button } from "@/components/ui/button";
import { usePrefs, DEFAULT_OVERVIEW_ORDER, OVERVIEW_PRESETS, type HistoryWindowPref } from "@/lib/prefs";
import {
  formatBytes,
  formatPercent,
  formatRate,
  formatTemp,
  formatUptime,
  humanState,
} from "@/lib/utils";
import type { HealthSummary, InsightsPayload } from "@/lib/api-types";

function HealthBanner({ health }: { health: HealthSummary }) {
  if (!health.level || health.level === "healthy") return null;
  const critical = health.level === "critical";
  const counts = health.counts;
  const summaryParts: string[] = [];
  if (counts) {
    if (counts.critical > 0) summaryParts.push(`${counts.critical} critical`);
    if (counts.warning > 0) summaryParts.push(`${counts.warning} warning`);
    if (counts.info > 0) summaryParts.push(`${counts.info} info`);
  }
  /* Fase 20 hierarchy: ONE summary line + the top incident + a link into
     the Incident Center. The full list lives there — the Overview never
     repeats every incident title in three places. */
  return (
    <section
      role={critical ? "alert" : "status"}
      aria-label={`System health: ${health.level}`}
      className={
        critical
          ? "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3"
          : "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3"
      }
      data-testid="health-banner"
    >
      <p className="flex items-center gap-2 text-sm font-medium">
        <span
          aria-hidden="true"
          className={
            critical
              ? "size-2 rounded-full bg-destructive"
              : "size-2 animate-pulse rounded-full bg-warning"
          }
        />
        {summaryParts.length > 0 ? `${summaryParts.join(" · ")} incident(s)` : "Needs attention"}
      </p>
      {health.reasons[0] ? (
        <p className="truncate text-sm text-muted-foreground">{health.reasons[0]}</p>
      ) : null}
      <Link
        href="/incidents"
        className="ml-auto inline-flex items-center gap-1 text-sm font-medium underline-offset-2 hover:underline"
        data-testid="incidents-link"
      >
        Open Incident Center
      </Link>
    </section>
  );
}

/** Overview insights strip (v1.6.0 Fase 17): max 2-3 insights, never
 *  duplicating active incidents — a calm pointer into /insights. */
const INSIGHTS_STRIP_POLL_MS = 120_000;

function OverviewInsightsStrip() {
  const { data } = usePoll<InsightsPayload>("/api/insights", INSIGHTS_STRIP_POLL_MS);
  const picks = (data?.sections.watchSoon ?? []).slice(0, 3);
  if (picks.length === 0) return null;
  return (
    <section aria-label="Operational insights" className="space-y-1.5" data-testid="overview-insights">
      {picks.map((insight) => (
        <Link
          key={insight.id}
          href={insight.deepLink}
          className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg border border-border/50 bg-card/30 px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/30"
        >
          <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">
            insight
          </span>
          <span className="font-medium text-foreground/80">{insight.title}</span>
          <span className="truncate">{insight.summary}</span>
          <span className="ml-auto text-xs">confidence: {insight.confidence}</span>
        </Link>
      ))}
    </section>
  );
}

export default function OverviewPage() {  const overview = useOverview();
  const { prefs, setPref } = usePrefs();
  const payload = overview.data;
  const loading = overview.loading && !payload;
  const extras = payload?.extras ?? null;
  const [customizeLayout, setCustomizeLayout] = useState(false);

  /** Keyboard-accessible card reordering (no drag/drop dependency). */
  const moveCard = (id: string, direction: -1 | 1) => {
    const order = [...prefs.overviewOrder];
    const from = order.indexOf(id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    setPref("overviewOrder", order);
  };

  return (
    <PageStack>
      {overview.error && payload && (
        <p role="alert" className="text-xs text-warning">
          Refresh failed ({overview.error}) — showing last known data, retrying.
        </p>
      )}
      {payload?.health && <HealthBanner health={payload.health} />}
      <OverviewInsightsStrip />

      {loading || !payload ? (
        <HeroStripSkeleton />
      ) : (
        <HeroStrip
          serverName={payload.identity.data?.serverName ?? null}
          osVersion={payload.identity.data?.osVersion ?? null}
          uptimeSeconds={payload.identity.data?.uptimeSeconds ?? null}
          healthLevel={payload.health.level}
          containersRunning={payload.docker.data?.running ?? null}
          containersTotal={payload.docker.data?.total ?? null}
        />
      )}

      <section
        aria-label="Resource summary"
        className="grid grid-cols-1 gap-card sm:grid-cols-2 xl:grid-cols-3"
      >
        <div className="col-span-full -mb-1 flex items-center gap-2">
          <Button
            size="sm"
            variant={customizeLayout ? "secondary" : "ghost"}
            aria-pressed={customizeLayout}
            onClick={() => setCustomizeLayout((value) => !value)}
            className="h-6 px-2 text-[11px]"
          >
            {customizeLayout ? "Done reordering" : "Customize layout"}
          </Button>
          {customizeLayout && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPref("overviewOrder", [...DEFAULT_OVERVIEW_ORDER])}
              className="h-6 px-2 text-[11px]"
            >
              Reset order
            </Button>
          )}
          {customizeLayout && (
            <>
              <span className="text-[11px] text-muted-foreground">Preset:</span>
              {Object.entries(OVERVIEW_PRESETS).map(([key, preset]) => (
                <Button
                  key={key}
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => {
                    const patch = preset.apply();
                    for (const [patchKey, patchValue] of Object.entries(patch)) {
                      setPref(patchKey as "overviewOrder", patchValue as never);
                    }
                  }}
                >
                  {preset.label}
                </Button>
              ))}
            </>
          )}
        </div>
        {loading || !payload
          ? Array.from({ length: 6 }).map((_, index) => (
              <MetricCardSkeleton key={index} />
            ))
          : (() => {
              const cpu = payload.cpu;
              const memory = payload.memory;
              const storage = payload.storage;
              const network = payload.network;
              const docker = payload.docker;
              const identity = payload.identity;
              const temp = payload.temperature.data;
              const thermal = extras?.thermal ?? null;
              const load = extras?.load ?? null;
              const unhealthy = extras?.unhealthyContainers ?? 0;
              const highMem = extras?.highMemoryContainers ?? 0;
              return (
                <>
                  {prefs.overviewOrder.map((cardId) => {
                    const card =
                      cardId === "cpu" ? (
                        <MetricCard
                          key="cpu"
                          label="CPU"
                          icon={Cpu}
                          section={cpu}
                          value={formatPercent(cpu.data?.percentTotal)}
                          percent={cpu.data?.percentTotal ?? null}
                          detail={
                            <>
                              {load && load.five !== null ? (
                                <span className="block">
                                  load {load.one?.toFixed(2) ?? "—"} / {load.five.toFixed(2)} /{" "}
                                  {load.fifteen?.toFixed(2) ?? "—"}
                                  {load.threads !== null && ` · ${load.threads} threads`}
                                </span>
                              ) : null}
                              {thermal && thermal.packageC !== null ? (
                                <span
                                  className={`inline-flex items-center gap-1 ${
                                    (thermal.peak1hC ?? 0) >= 90 ? "text-destructive" : ""
                                  }`}
                                >
                                  <Thermometer className="size-3" aria-hidden="true" />
                                  {formatTemp(thermal.packageC, prefs.tempUnit)}
                                  {thermal.peak1hC !== null &&
                                    ` · 1h peak ${formatTemp(thermal.peak1hC, prefs.tempUnit)}`}
                                </span>
                              ) : null}
                              {temp && temp.criticalCount > 0 && (
                                <span className="block text-destructive">
                                  {temp.criticalCount} sensor(s) critical
                                </span>
                              )}
                            </>
                          }
                        />
                      ) : cardId === "memory" ? (
                        <MetricCard
                          key="memory"
                          label="Memory"
                          icon={MemoryStick}
                          section={memory}
                          value={formatPercent(memory.data?.percentTotal)}
                          percent={memory.data?.percentTotal ?? null}
                          detail={`${formatBytes(memory.data?.usedBytes)} of ${formatBytes(memory.data?.totalBytes)}${
                            memory.data?.availableBytes != null
                              ? ` · ${formatBytes(memory.data.availableBytes)} available`
                              : ""
                          }`}
                        />
                      ) : cardId === "uptime" ? (
                        <MetricCard
                          key="uptime"
                          label="Uptime"
                          icon={Clock}
                          section={identity}
                          value={formatUptime(identity.data?.uptimeSeconds)}
                          detail={
                            identity.data?.osVersion
                              ? `Unraid v${identity.data.osVersion}`
                              : undefined
                          }
                        />
                      ) : cardId === "array" ? (
                        <MetricCard
                          key="array"
                          label="Array usage"
                          icon={HardDrive}
                          section={storage}
                          value={formatBytes(storage.data?.usedBytes)}
                          percent={
                            storage.data && storage.data.totalBytes > 0
                              ? (storage.data.usedBytes / storage.data.totalBytes) * 100
                              : null
                          }
                          detail={
                            storage.data ? (
                              <>
                                <span className="block">
                                  of {formatBytes(storage.data.totalBytes)} · {storage.data.disks.length}{" "}
                                  disks · {humanState(storage.data.state)}
                                </span>
                                {extras?.diskIo &&
                                  (extras.diskIo.readBytesPerSec !== null ||
                                    extras.diskIo.writeBytesPerSec !== null) && (
                                    <span className="block">
                                      disk I/O ↓ {formatRate(extras.diskIo.readBytesPerSec)} · ↑{" "}
                                      {formatRate(extras.diskIo.writeBytesPerSec)}
                                    </span>
                                  )}
                              </>
                            ) : undefined
                          }
                        />
                      ) : cardId === "network" ? (
                        <MetricCard
                          key="network"
                          label="Network"
                          icon={ArrowDownToLine}
                          section={network}
                          value={formatRate(extras?.primaryRx ?? network.data?.rxBytesPerSec)}
                          detail={
                            <>
                              <span className="inline-flex items-center gap-1">
                                <ArrowUpFromLine className="size-3" aria-hidden="true" />
                                TX {formatRate(extras?.primaryTx ?? network.data?.txBytesPerSec)}
                              </span>
                              {extras?.primaryInterface && (
                                <span className="block">{extras.primaryInterface}</span>
                              )}
                            </>
                          }
                        />
                      ) : (
                        <MetricCard
                          key="docker"
                          label="Docker"
                          icon={Boxes}
                          section={docker}
                          value={
                            docker.data ? `${docker.data.running}/${docker.data.total}` : "—"
                          }
                          detail={
                            <>
                              {(unhealthy > 0 || highMem > 0) && (
                                <span className="block">
                                  {unhealthy > 0 && `${unhealthy} unhealthy`}
                                  {unhealthy > 0 && highMem > 0 && " · "}
                                  {highMem > 0 && `${highMem} high memory`}
                                </span>
                              )}
                              <Link
                                href="/docker"
                                className="underline-offset-2 hover:underline"
                              >
                                View containers
                              </Link>
                            </>
                          }
                        />
                      );
                    if (!customizeLayout) return card;
                    const position = prefs.overviewOrder.indexOf(cardId);
                    return (
                      <div key={cardId} className="relative">
                        <div className="absolute right-2 top-2 z-10 flex gap-0.5">
                          <button
                            type="button"
                            aria-label={`Move ${cardId} card earlier`}
                            disabled={position === 0}
                            onClick={() => moveCard(cardId, -1)}
                            className="rounded bg-background/80 px-1 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-30"
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            aria-label={`Move ${cardId} card later`}
                            disabled={position === prefs.overviewOrder.length - 1}
                            onClick={() => moveCard(cardId, 1)}
                            className="rounded bg-background/80 px-1 text-xs text-muted-foreground hover:bg-secondary disabled:opacity-30"
                          >
                            ↓
                          </button>
                        </div>
                        {card}
                      </div>
                    );
                  })}
                </>
              );
            })()}
      </section>

      {/* Overview flow model (v0.9.12): TWO INDEPENDENT COLUMN STACKS instead
          of row-paired grids. Row pairing reserved the taller sibling's height
          across both columns, leaving a blank band under every shorter card.
          Independent stacks pack continuously: the next card moves up. */}
      {payload && (
        <section aria-label="Server detail" className="grid items-start gap-card xl:grid-cols-2">
          <SectionStack className="min-w-0">
            <div className="min-w-0">
              <SeriesChart
                series={[
                  {
                    name: "CPU %",
                    points: payload.history.samples.map((sample) => ({
                      t: sample.time,
                      v: Number.isFinite(sample.cpu) ? sample.cpu : null,
                    })),
                  },
                  {
                    name: "RAM %",
                    points: payload.history.samples.map((sample) => ({
                      t: sample.time,
                      v: Number.isFinite(sample.memory) ? sample.memory : null,
                    })),
                  },
                ]}
                unit="percent"
                unavailable={
                  payload.history.status === "unavailable" &&
                  payload.history.samples.length === 0
                }
                unavailableReason={
                  payload.history.source !== "prometheus"
                    ? "History unavailable — Prometheus unreachable and the in-memory buffer is still filling."
                    : undefined
                }
              />
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <WindowPicker
                  value={prefs.historyWindow}
                  onChange={(value: HistoryWindowPref) => setPref("historyWindow", value)}
                />
                <p className="text-[11px] text-muted-foreground">
                  {payload.history.source === "prometheus"
                    ? `source: Prometheus · ${payload.history.status}`
                    : "source: in-memory buffer (Prometheus unavailable)"}
                  {payload.history.status === "stale" && " · stale"}
                </p>
              </div>
            </div>
            <TopConsumersCard consumers={extras?.topConsumers ?? null} />
            <DockerOverviewList docker={payload.docker} />
          </SectionStack>
          <SectionStack className="min-w-0">
            <StorageOverview storage={payload.storage} />
            <NotificationsCard notifications={payload.notifications} />
            {extras && !extras.prometheus.configured && (
              <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                Prometheus is not configured — runtime metrics, history and
                container charts are hidden. Unraid state remains live. Set
                PROMETHEUS_URL to enable them.
              </p>
            )}
            {extras?.prometheus.configured && extras.prometheus.status !== "live" && (
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                <MetricStatus meta={{
                  source: "prometheus",
                  status: extras.prometheus.status,
                  sampledAt: "",
                  reason: extras.prometheus.reason,
                }} />
                <p className="mt-1 text-muted-foreground">
                  Prometheus-derived widgets may be empty or stale. Unraid state
                  pages remain live.
                </p>
              </div>
            )}
          </SectionStack>
        </section>
      )}
    </PageStack>
  );
}
