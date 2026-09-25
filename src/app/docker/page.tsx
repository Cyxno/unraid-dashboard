"use client";

import { useMemo, useState } from "react";
import {
  Boxes,
  ExternalLink,
  Filter,
  PauseCircle,
  PlayCircle,
  Search,
  StopCircle,
  TriangleAlert,
  X,
} from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  cn,
  formatBytes,
  formatPercent,
} from "@/lib/utils";
import type {
  ContainerHealth,
  ContainerHistoryPayload,
  DockerContainerSummary,
  DockerSummary,
  Section,
} from "@/lib/api-types";

/**
 * Thresholds mirrored from server/thresholds.ts for client-side filter
 * presets. Both sides use the same documented values.
 */
const HIGH_CPU_PERCENT = 80;
const HIGH_MEMORY_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
const HIGH_MEMORY_PERCENT_OF_LIMIT = 80;

type StatusFilter =
  | "all"
  | "running"
  | "stopped"
  | "unhealthy"
  | "update"
  | "high-cpu"
  | "high-memory";
type SortKey = "name" | "state" | "cpu" | "memory";
type GroupMode = "flat" | "compose";

const STATE_META = {
  RUNNING: { label: "Running", Icon: PlayCircle, iconClass: "text-success" },
  PAUSED: { label: "Paused", Icon: PauseCircle, iconClass: "text-warning" },
  EXITED: { label: "Stopped", Icon: StopCircle, iconClass: "text-muted-foreground" },
} as const;

function healthBadge(health: ContainerHealth) {
  if (!health) return null;
  if (health === "healthy") return <Badge variant="success">healthy</Badge>;
  if (health === "unhealthy") {
    return (
      <Badge variant="destructive" className="gap-1">
        <TriangleAlert aria-hidden="true" /> unhealthy
      </Badge>
    );
  }
  return <Badge variant="warning">starting</Badge>;
}

function isHighMemory(container: DockerContainerSummary): boolean {
  const metrics = container.metrics;
  if (!metrics) return false;
  if (
    metrics.hasMemoryLimit &&
    metrics.memoryPercentOfLimit !== null &&
    metrics.memoryPercentOfLimit >= HIGH_MEMORY_PERCENT_OF_LIMIT
  ) {
    return true;
  }
  return (
    metrics.memoryUsedBytes !== null &&
    metrics.memoryUsedBytes >= HIGH_MEMORY_BYTES
  );
}

function cpuCell(container: DockerContainerSummary) {
  const metrics = container.metrics;
  if (!metrics || metrics.cpuPercent === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const value = metrics.cpuPercent;
  return (
    <span
      className={cn(
        "font-mono tabular-nums",
        value >= HIGH_CPU_PERCENT && "text-warning",
      )}
    >
      {formatPercent(value)}
    </span>
  );
}

function memoryCell(container: DockerContainerSummary) {
  const metrics = container.metrics;
  if (!metrics || metrics.memoryUsedBytes === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-mono tabular-nums">
        {formatBytes(metrics.memoryUsedBytes)}
      </span>
      {metrics.hasMemoryLimit && metrics.memoryPercentOfLimit !== null ? (
        <span
          className={cn(
            "text-[11px] text-muted-foreground",
            metrics.memoryPercentOfLimit >= HIGH_MEMORY_PERCENT_OF_LIMIT &&
              "text-warning",
          )}
        >
          {Math.round(metrics.memoryPercentOfLimit)}% of limit
        </span>
      ) : (
        <span
          className="text-[11px] text-muted-foreground"
          title="No memory limit set — percentage intentionally not shown"
        >
          no limit
        </span>
      )}
    </span>
  );
}

/* Container detail drawer with metric history ---------------------------- */

function ContainerDetail({
  container,
  onClose,
}: {
  container: DockerContainerSummary;
  onClose: () => void;
}) {
  const [window, setWindow] = useState<HistoryWindowPref>("1h");
  const history = usePoll<ContainerHistoryPayload>(
    `/api/docker/history?name=${encodeURIComponent(container.name)}&window=${window}`,
    HISTORY_INTERVAL_MS[window],
  );
  const meta = STATE_META[container.state] ?? STATE_META.EXITED;
  const metrics = container.metrics;
  const metricsUnavailable = !metrics;

  const rows: Array<[string, React.ReactNode]> = [
    [
      "Image",
      <span key="image" className="break-all font-mono text-xs">{container.image}</span>,
    ],
    [
      "State",
      <span key="state" className="inline-flex items-center gap-2">
        <meta.Icon className={cn("size-4", meta.iconClass)} aria-hidden="true" />
        {meta.label}
        {healthBadge(container.health)}
      </span>,
    ],
    ["Docker status", container.status || "—"],
    ["Autostart", container.autoStart ? "Enabled" : "Disabled"],
    [
      "Update available",
      container.updateAvailable ? (
        <Badge key="update" variant="warning">update available</Badge>
      ) : (
        "No"
      ),
    ],
    [
      "Compose project",
      container.composeProject ? (
        <Badge key="compose" variant="secondary">{container.composeProject}</Badge>
      ) : (
        "—"
      ),
    ],
    [
      "Created",
      container.createdEpochSeconds
        ? new Date(container.createdEpochSeconds * 1000).toLocaleString()
        : "—",
    ],
    [
      "Ports",
      container.ports.length > 0 ? (
        <span key="ports" className="font-mono text-xs">
          {container.ports
            .map((port) =>
              port.publicPort != null
                ? `${port.publicPort}:${port.privatePort}/${port.type ?? "tcp"}`
                : `${port.privatePort}/${port.type ?? "tcp"}`,
            )
            .join(", ")}
        </span>
      ) : (
        "—"
      ),
    ],
    [
      "Container ID",
      <span key="cid" className="break-all font-mono text-xs">{container.id}</span>,
    ],
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        aria-label="Close details"
        onClick={onClose}
        className="absolute inset-0 bg-black/60"
      />
      <div
        role="dialog"
        aria-label={`${container.name} details`}
        className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l bg-card p-5 shadow-xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold">{container.name}</h3>
            <p className="truncate text-xs text-muted-foreground">{container.image}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {container.webUiUrl && (
              <Button variant="ghost" size="icon" asChild>
                <a
                  href={container.webUiUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`Open ${container.name} web UI`}
                >
                  <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close">
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>

        {/* Current resource use */}
        <div className="mb-4 grid grid-cols-3 gap-2">
          <div className="rounded-md border bg-secondary/30 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">CPU</p>
            <p className="font-mono text-sm tabular-nums">
              {metricsUnavailable ? "—" : formatPercent(metrics.cpuPercent)}
            </p>
          </div>
          <div className="rounded-md border bg-secondary/30 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">Memory</p>
            <p className="font-mono text-sm tabular-nums">
              {metricsUnavailable ? "—" : formatBytes(metrics.memoryUsedBytes)}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {metrics?.hasMemoryLimit && metrics.memoryPercentOfLimit !== null
                ? `${Math.round(metrics.memoryPercentOfLimit)}% of limit`
                : metrics
                  ? "no limit"
                  : ""}
            </p>
          </div>
          <div className="rounded-md border bg-secondary/30 px-3 py-2">
            <p className="text-[11px] text-muted-foreground">State</p>
            <p className="text-sm">{meta.label}</p>
          </div>
        </div>

        {/* Metric history */}
        <div className="mb-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-medium">History</h4>
            <WindowPicker
              value={window}
              onChange={setWindow}
              options={["5m", "15m", "1h", "6h", "24h"] as HistoryWindowPref[]}
            />
          </div>
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs text-muted-foreground">CPU %</p>
              {metricsUnavailable ? (
                <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                  Container metrics unavailable — Prometheus is unreachable.
                  Lifecycle state above remains live from Unraid.
                </p>
              ) : (
                <SeriesChart
                  series={[
                    { name: "CPU %", points: history.data?.cpu ?? [] },
                  ]}
                  unit="percent"
                  height={140}
                  unavailable={history.data?.meta.status === "unavailable"}
                />
              )}
            </div>
            <div>
              <p className="mb-1 text-xs text-muted-foreground">Memory</p>
              {metricsUnavailable ? null : (
                <SeriesChart
                  series={[
                    { name: "Memory", points: history.data?.memoryBytes ?? [] },
                  ]}
                  unit="bytes"
                  height={140}
                  unavailable={history.data?.meta.status === "unavailable"}
                />
              )}
            </div>
            {history.data?.meta.status === "stale" && (
              <MetricStatus meta={history.data.meta} />
            )}
          </div>
        </div>

        <dl className="space-y-3">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[120px_1fr] gap-2 text-sm">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="min-w-0">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Read-only view. Container lifecycle actions are intentionally not
          available in this version. Environment variables are not shown to avoid
          exposing secret values.
        </p>
      </div>
    </div>
  );
}

export default function DockerPage() {
  const { data, error, loading } = usePoll<Section<DockerSummary>>(
    "/api/docker",
    PAGE_INTERVAL_MS.docker,
  );
  const { prefs, setPref } = usePrefs();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [groupMode, setGroupMode] = useState<GroupMode>("flat");
  const [selected, setSelected] = useState<string | null>(null);

  const containers = useMemo(
    () => data?.data?.containers ?? [],
    [data],
  );

  const composeProjects = useMemo(() => {
    const projects = new Set<string>();
    for (const container of containers) {
      if (container.composeProject) projects.add(container.composeProject);
    }
    return [...projects].sort();
  }, [containers]);

  const metricsLive = data?.data?.metricsMeta?.status === "live";

  const visible = useMemo(() => {
    let list = containers;
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (container) =>
          container.name.toLowerCase().includes(q) ||
          container.image.toLowerCase().includes(q) ||
          (container.composeProject ?? "").toLowerCase().includes(q),
      );
    }
    if (filter === "running") list = list.filter((c) => c.state === "RUNNING");
    if (filter === "stopped") list = list.filter((c) => c.state === "EXITED");
    if (filter === "unhealthy")
      list = list.filter((c) => c.health === "unhealthy");
    if (filter === "update") list = list.filter((c) => c.updateAvailable);
    if (filter === "high-cpu")
      list = list.filter(
        (c) => (c.metrics?.cpuPercent ?? -1) >= HIGH_CPU_PERCENT,
      );
    if (filter === "high-memory") list = list.filter(isHighMemory);
    const sorted = [...list].sort((a, b) => {
      let comparison: number;
      if (sortKey === "cpu") {
        comparison = (a.metrics?.cpuPercent ?? -1) - (b.metrics?.cpuPercent ?? -1);
      } else if (sortKey === "memory") {
        comparison =
          (a.metrics?.memoryUsedBytes ?? -1) - (b.metrics?.memoryUsedBytes ?? -1);
      } else if (sortKey === "state") {
        comparison = a.state.localeCompare(b.state);
      } else {
        comparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      }
      return sortAsc ? comparison : -comparison;
    });
    return sorted;
  }, [containers, query, filter, sortKey, sortAsc]);

  const grouped = useMemo<
    Array<{ project: string | null; items: DockerContainerSummary[] }>
  >(() => {
    if (groupMode === "flat") return [{ project: null, items: visible }];
    const map = new Map<string, DockerContainerSummary[]>();
    const ungrouped: DockerContainerSummary[] = [];
    for (const container of visible) {
      if (container.composeProject) {
        const list = map.get(container.composeProject) ?? [];
        list.push(container);
        map.set(container.composeProject, list);
      } else {
        ungrouped.push(container);
      }
    }
    const groups: Array<{
      project: string | null;
      items: DockerContainerSummary[];
    }> = [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([project, items]) => ({ project, items }));
    if (ungrouped.length > 0) {
      groups.push({ project: null, items: ungrouped });
    }
    return groups;
  }, [visible, groupMode]);

  const selectedContainer =
    containers.find((container) => container.id === selected) ?? null;

  const compact = prefs.density === "compact";
  const showMetrics = prefs.dockerMetrics && metricsLive;

  const sortButton = (key: SortKey, label: string) => (
    <Button
      size="sm"
      variant={sortKey === key ? "secondary" : "ghost"}
      aria-pressed={sortKey === key}
      className="h-7 px-2.5 text-xs"
      onClick={() => {
        if (sortKey === key) setSortAsc((value) => !value);
        else {
          setSortKey(key);
          setSortAsc(key === "cpu" || key === "memory" ? false : true);
        }
      }}
    >
      {label} {sortKey === key ? (sortAsc ? "↑" : "↓") : ""}
    </Button>
  );

  return (
    <div>
      <PageHeader
        title="Docker"
        description={
          data?.data
            ? `${data.data.running} of ${data.data.total} containers running`
            : "Containers, status and runtime metrics"
        }
        actions={
          <SectionStatus
            section={
              data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }
            }
          />
        }
      />

      {data?.data?.metricsMeta && data.data.metricsMeta.status !== "live" && (
        <div className="mb-3">
          <MetricStatus meta={data.data.metricsMeta} />
        </div>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <label className="relative">
          <span className="sr-only">Search containers</span>
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, image, project…"
            className="h-9 w-56 rounded-md border bg-card pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>

        <div role="group" aria-label="Filter containers" className="flex items-center gap-1">
          <Filter className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {(
            [
              "all",
              "running",
              "stopped",
              "unhealthy",
              "update",
              "high-cpu",
              "high-memory",
            ] as const
          ).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={filter === option ? "secondary" : "ghost"}
              aria-pressed={filter === option}
              onClick={() => setFilter(option)}
              className="h-7 px-2.5 text-xs capitalize"
              title={
                option === "high-cpu"
                  ? `CPU ≥ ${HIGH_CPU_PERCENT}%`
                  : option === "high-memory"
                    ? `Memory ≥ ${formatBytes(HIGH_MEMORY_BYTES, 0)} or ≥ ${HIGH_MEMORY_PERCENT_OF_LIMIT}% of limit`
                    : undefined
              }
            >
              {option}
            </Button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          {sortButton("cpu", "CPU")}
          {sortButton("memory", "Mem")}
          {sortButton("name", "Name")}
          {sortButton("state", "State")}
          {composeProjects.length > 0 && (
            <Button
              size="sm"
              variant={groupMode === "compose" ? "secondary" : "ghost"}
              aria-pressed={groupMode === "compose"}
              className="h-7 px-2.5 text-xs"
              onClick={() =>
                setGroupMode(groupMode === "flat" ? "compose" : "flat")
              }
              title="Group by Docker Compose project (from container labels)"
            >
              By project
            </Button>
          )}
          <Button
            size="sm"
            variant={compact ? "secondary" : "ghost"}
            aria-pressed={compact}
            onClick={() => setPref("density", compact ? "comfortable" : "compact")}
            className="h-7 px-2.5 text-xs"
          >
            {compact ? "Compact" : "Comfortable"}
          </Button>
        </div>
      </div>

      {loading && containers.length === 0 ? (
        <LoadingPanel rows={8} />
      ) : error && !data ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        >
          Docker data unavailable: {error}
        </p>
      ) : visible.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {containers.length === 0
            ? "No Docker containers installed."
            : "No containers match the current search/filter."}
        </p>
      ) : (
        grouped.map((group) => (
          <div key={group.project ?? "flat"} className="mb-4">
            {group.project !== null && (
              <h3 className="mb-1.5 mt-3 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Boxes className="size-3.5" aria-hidden="true" />
                {group.project}
                <Badge variant="secondary" className="text-[10px]">
                  {group.items.length}
                </Badge>
              </h3>
            )}
            <Card className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <caption className="sr-only">
                  Docker containers{group.project ? ` in project ${group.project}` : ""}
                </caption>
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th scope="col" className="px-4 py-2.5 font-medium">Container</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">State</th>
                    {showMetrics && (
                      <th scope="col" className="px-4 py-2.5 text-right font-medium">
                        CPU
                      </th>
                    )}
                    {showMetrics && (
                      <th scope="col" className="px-4 py-2.5 text-right font-medium">
                        Memory
                      </th>
                    )}
                    <th
                      scope="col"
                      className={cn(
                        "px-4 py-2.5 font-medium",
                        compact && "hidden sm:table-cell",
                      )}
                    >
                      Status
                    </th>
                    <th scope="col" className="hidden px-4 py-2.5 font-medium md:table-cell">
                      Ports
                    </th>
                    <th scope="col" className="hidden px-4 py-2.5 font-medium lg:table-cell">
                      Image
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {group.items.map((container) => {
                    const meta =
                      STATE_META[container.state] ?? STATE_META.EXITED;
                    return (
                      <tr
                        key={container.id}
                        tabIndex={0}
                        onClick={() => setSelected(container.id)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setSelected(container.id);
                          }
                        }}
                        aria-label={`Show details for ${container.name}`}
                        className={cn(
                          "cursor-pointer border-b last:border-0 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          compact ? "text-xs" : "",
                        )}
                      >
                        <td className="max-w-[220px] px-4 py-2.5">
                          <p className="flex items-center gap-1.5 truncate font-medium">
                            {container.name}
                            {container.updateAvailable && (
                              <Badge variant="warning" className="text-[10px]">
                                update
                              </Badge>
                            )}
                            {healthBadge(container.health)}
                          </p>
                          {!compact && group.project === null && container.composeProject && (
                            <p className="truncate text-[11px] text-muted-foreground">
                              {container.composeProject}
                            </p>
                          )}
                          {!compact && group.project !== null && (
                            <p className="truncate text-xs text-muted-foreground">
                              {container.image}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="inline-flex items-center gap-2">
                            <meta.Icon
                              className={cn("size-4", meta.iconClass)}
                              aria-hidden="true"
                            />
                            {meta.label}
                            <span className="sr-only">{container.state}</span>
                          </span>
                        </td>
                        {showMetrics && (
                          <td className="px-4 py-2.5 text-right">
                            {container.state === "RUNNING"
                              ? cpuCell(container)
                              : null}
                          </td>
                        )}
                        {showMetrics && (
                          <td className="px-4 py-2.5 text-right">
                            {container.state === "RUNNING"
                              ? memoryCell(container)
                              : null}
                          </td>
                        )}
                        <td
                          className={cn(
                            "px-4 py-2.5 text-xs text-muted-foreground",
                            compact && "hidden sm:table-cell",
                          )}
                        >
                          {container.status}
                        </td>
                        <td className="hidden px-4 py-2.5 font-mono text-xs text-muted-foreground md:table-cell">
                          {container.ports.length > 0
                            ? container.ports
                                .slice(0, 3)
                                .map((port) =>
                                  port.publicPort != null
                                    ? `${port.publicPort}→${port.privatePort}`
                                    : `${port.privatePort}`,
                                )
                                .join(", ") + (container.ports.length > 3 ? "…" : "")
                            : "—"}
                        </td>
                        <td className="hidden max-w-[200px] px-4 py-2.5 lg:table-cell">
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {container.image}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          </div>
        ))
      )}

      {selectedContainer && (
        <ContainerDetail container={selectedContainer} onClose={() => setSelected(null)} />
      )}

      <p className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Boxes className="size-3.5" aria-hidden="true" />
        Read-only view — container actions are intentionally out of scope.
        {showMetrics
          ? ` Runtime metrics from Prometheus (docker stats, 15s). Filters: high CPU ≥ ${HIGH_CPU_PERCENT}%, high memory ≥ ${formatBytes(HIGH_MEMORY_BYTES, 0)} or ≥ ${HIGH_MEMORY_PERCENT_OF_LIMIT}% of limit.`
          : " Runtime metrics unavailable — Prometheus not reachable."}
      </p>
    </div>
  );
}
