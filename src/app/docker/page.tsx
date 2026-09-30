"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import {
  Boxes,
  Filter,
  PauseCircle,
  PlayCircle,
  Search,
  StopCircle,
  TriangleAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { usePoll } from "@/hooks/use-poll";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import {
  HISTORY_INTERVAL_MS,
  PAGE_INTERVAL_MS,
  usePrefs,
  type HistoryWindowPref,
} from "@/lib/prefs";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { DockerUpdatesPanel } from "@/components/docker/updates-panel";
import { useDockerAction } from "@/components/actions/use-docker-action";
import { ConfirmDialog } from "@/components/actions/confirm-dialog";
import { useToast } from "@/components/layout/toast";
import { useDashboardEvents } from "@/hooks/use-dashboard-events";
import { ComposeProjectsPanel } from "@/components/docker/projects-panel";
import { UpdateHistoryPanel } from "@/components/docker/update-history-panel";
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

type QuickFilter = "all" | "running" | "problems" | "update" | "stopped";
type StatusFilter =
  | "all"
  | "running"
  | "stopped"
  | "problems"
  | "update"
  | "high-cpu"
  | "high-memory";
type SortKey = "name" | "state" | "cpu" | "memory" | "operational";
type GroupMode = "flat" | "compose";

const STATE_META = {
  RUNNING: { label: "Running", Icon: PlayCircle, iconClass: "text-success" },
  PAUSED: { label: "Paused", Icon: PauseCircle, iconClass: "text-warning" },
  EXITED: { label: "Stopped", Icon: StopCircle, iconClass: "text-muted-foreground" },
} as const;

/**
 * Collapsible secondary section (v0.9.5): children mount only while
 * expanded, so the updates sweep / project / history polls never start
 * just because the page loaded. The container list is the first paint.
 * v0.9.9: optional collapsed-only summary line (e.g. cached update
 * count + check age) next to the label.
 */
/**
 * Controlled lazy section (v0.9.12): expansion state lives in the page so
 * the anchor row can open a section in ONE action (expand -> mount ->
 * scroll -> focus). Children still mount only while expanded, so page
 * entry never starts the updates sweep / project / history polls.
 */
function LazySection({
  sectionKey,
  open,
  onOpenChange,
  label,
  openHint,
  summary,
  highlight,
  children,
}: {
  sectionKey: string;
  open: boolean;
  onOpenChange: (key: string, open: boolean) => void;
  label: string;
  openHint?: string;
  summary?: React.ReactNode;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      id={`docker-${sectionKey}-details`}
      open={open}
      onToggle={(event) => onOpenChange(sectionKey, (event.target as HTMLDetailsElement).open)}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
        {summary && (
          <span className="font-normal normal-case tracking-normal text-[11px] text-muted-foreground group-open:hidden">
            · {summary}
          </span>
        )}
        <span className="ml-auto text-[10px] normal-case text-muted-foreground group-open:hidden">
          {openHint ?? "show"}
        </span>
      </summary>
      {open && <div className="pt-2">{children}</div>}
    </details>
  );
}

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

export default function DockerPage() {
  const { data, error, loading } = usePoll<Section<DockerSummary>>(
    "/api/docker",
    PAGE_INTERVAL_MS.docker,
  );
  const { prefs, setPref } = usePrefs();
  const [query, setQuery] = useState("");
  // Light debounce: filtering stays instant-feeling but the full
  // filter+sort+group pass runs at most every 150ms while typing.
  const debouncedQuery = useDebouncedValue(query, 150);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sortKey, setSortKey] = useState<SortKey>("operational");
  const [sortAsc, setSortAsc] = useState(true);
  const [groupMode, setGroupMode] = useState<GroupMode>("flat");
  // Quick actions (v0.9.10): the shared verified-action controller —
  // confirm → request → transition → SSE confirmation → poll fallback →
  // timeout → toast. Identical semantics to the container detail page.
  const dockerAction = useDockerAction();

  // Section navigation (v0.9.12): ONE handler for the anchor row —
  // expands (and lazily mounts) the target section, scrolls it into view
  // with the sticky-header offset, moves focus, and briefly highlights
  // it. Page entry still mounts nothing beyond the container list.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [highlightSection, setHighlightSection] = useState<string | null>(null);
  const navigateToDockerSection = useCallback((key: "containers" | "updates" | "projects" | "history") => {
    setOpenSections((current) => ({ ...current, [key]: true }));
    requestAnimationFrame(() => {
      setTimeout(() => {
        const element = document.getElementById(`docker-${key}`);
        if (!element) return;
        const headerOffset = 64; // sticky header (56px) + breathing room
        const top = element.getBoundingClientRect().top + window.scrollY - headerOffset;
        window.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
        element.focus({ preventScroll: true });
        setHighlightSection(key);
        // Corrective re-scroll: the lazily mounted panel grows as its data
        // lands, which would otherwise leave the section above the viewport.
        // Follow size changes for ~2s, then stop (bounded).
        const target = document.getElementById(`docker-${key}`);
        if (target && typeof ResizeObserver !== "undefined") {
          let last = 0;
          const observer = new ResizeObserver(() => {
            const now = Date.now();
            if (now - last < 300) return; // throttle smooth scrolls
            last = now;
            const corrected = target.getBoundingClientRect().top + window.scrollY - 64;
            window.scrollTo({ top: Math.max(0, corrected), behavior: "smooth" });
          });
          observer.observe(target);
          setTimeout(() => observer.disconnect(), 2_000);
        }
        setTimeout(() => setHighlightSection(null), 1_600);
      }, key === "containers" ? 0 : 60);
    });
  }, []);
  const router = useRouter();

  // Lightweight update awareness (v0.9.9): cached count only — this poll
  // never triggers the registry sweep (the endpoint serves cache state).
  const updateSummary = usePoll<{
    available: boolean;
    lastCheckAt: string | null;
    ageSeconds: number | null;
    stale: boolean;
    checking: boolean;
    knownUpdatesCount: number | null;
  }>("/api/docker/updates-summary", 60_000);
  const updateCount = updateSummary.data?.knownUpdatesCount ?? null;
  const updateAge = updateSummary.data?.ageSeconds ?? null;
  const updateStale = updateSummary.data?.stale ?? false;
  const updateSummaryText = !updateSummary.data?.available
    ? "Not checked yet"
    : updateCount !== null
      ? `${updateCount} known update${updateCount === 1 ? "" : "s"} · ${
          updateStale ? "stale" : updateAge != null ? `checked ${formatAge(updateAge)}` : "checking…"
        }`
      : null;

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
    const q = debouncedQuery.trim().toLowerCase();
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
    if (filter === "problems")
      list = list.filter(
        (c) =>
          c.state !== "RUNNING" ||
          c.health === "unhealthy" ||
          (c.metrics && (c.metrics.cpuPercent ?? -1) >= HIGH_CPU_PERCENT) ||
          isHighMemory(c),
      );
    if (filter === "update") list = list.filter((c) => c.updateAvailable);
    if (filter === "high-cpu")
      list = list.filter(
        (c) => (c.metrics?.cpuPercent ?? -1) >= HIGH_CPU_PERCENT,
      );
    if (filter === "high-memory") list = list.filter(isHighMemory);
    const priority = (c: DockerContainerSummary): number => {
      // Problems first (unhealthy/restarting), then running, stopped, unknown.
      if (c.health === "unhealthy") return 0;
      if (c.state === "RUNNING") return 1;
      if (c.state === "EXITED" || c.state === "PAUSED") return 2;
      return 3;
    };
    const sorted = [...list].sort((a, b) => {
      let comparison: number;
      if (sortKey === "operational") {
        comparison = priority(a) - priority(b);
        if (comparison === 0) comparison = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
        return sortAsc ? comparison : -comparison;
      }
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
  }, [containers, debouncedQuery, filter, sortKey, sortAsc]);

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

      {/* Anchor navigation (v0.9.5) */}
      <nav
        aria-label="Docker page sections"
        className="mb-3 flex flex-nowrap items-center gap-1.5 overflow-x-auto pb-1 text-xs md:flex-wrap md:overflow-visible md:pb-0"
      >
        {(
          [
            ["containers", "Containers"],
            ["updates", updateCount != null && updateCount > 0 ? `Updates (${updateCount})` : "Updates"],
            ["projects", "Projects"],
            ["history", "History"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-expanded={key === "containers" ? undefined : Boolean(openSections[key])}
            aria-current={highlightSection === key ? "true" : undefined}
            onClick={() => navigateToDockerSection(key)}
            className={cn(
              "shrink-0 rounded-full border px-2.5 py-1 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              key === "updates" && updateCount != null && updateCount > 0 && "border-warning/50 text-warning",
              highlightSection === key && "border-primary/60 bg-primary/10 text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <section
        id="docker-containers"
        aria-label="Containers"
        tabIndex={-1}
        className={cn("outline-none", highlightSection === "containers" && "rounded-lg ring-2 ring-primary/40")}
      >
      <div className="mb-3 flex flex-col gap-2 md:flex-row md:flex-wrap md:items-center">
        <label className="relative md:w-56">
          <span className="sr-only">Search containers</span>
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name, image, project…"
            className="h-10 w-full rounded-md border bg-card pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring md:w-56"
          />
        </label>

        {/* Summary chips (v0.9.2): click to filter — own row on phones so
            flex-shrink inside the scrolling tab strip can never squeeze
            them into a vertical stack (v0.9.5). */}
        {(() => {
          const counts = {
            running: containers.filter((c) => c.state === "RUNNING").length,
            stopped: containers.filter((c) => c.state === "EXITED").length,
            problems: containers.filter((c) => c.state !== "RUNNING" || c.health === "unhealthy").length,
            update: containers.filter((c) => c.updateAvailable).length,
          };
          const chip = (key: StatusFilter, label: string, count: number) => (
            <Button
              key={key}
              size="sm"
              variant={filter === key ? "secondary" : "ghost"}
              aria-pressed={filter === key}
              onClick={() => setFilter(filter === key ? "all" : key)}
              className="h-7 gap-1.5 px-2 text-[11px]"
            >
              {label}
              <span className="tnum rounded bg-muted px-1 text-[10px] text-muted-foreground">{count}</span>
            </Button>
          );
          return (
            <div className="-mb-1 flex flex-wrap items-center gap-1.5">
              {chip("running", "Running", counts.running)}
              {chip("problems", "Problems", counts.problems)}
              {chip("update", "Updates", counts.update)}
              {chip("stopped", "Stopped", counts.stopped)}
            </div>
          );
        })()}

        <div role="group" aria-label="Filter containers" className="flex items-center gap-1 overflow-x-auto pb-1 md:flex-wrap md:pb-0">
          <Filter className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {(
            [
              "all",
              "running",
              "problems",
              "update",
              "stopped",
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
              className="h-8 shrink-0 whitespace-nowrap px-2.5 text-xs capitalize"
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

        <div className="flex flex-wrap items-center gap-1 md:ml-auto">
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
        <>
        {/* Mobile: card list instead of the desktop table. */}
        <div className="grid gap-2 md:hidden">
          {visible.map((container) => {
            const cMeta = STATE_META[container.state] ?? STATE_META.EXITED;
            return (
              <Card
                key={container.id}
                className="gap-0 p-3 [contain-intrinsic-size:auto_76px] [content-visibility:auto]"
              >
                <button
                  type="button"
                  className="w-full text-left"
                  aria-label={`Open details for ${container.name}`}
                  onClick={() =>
                    router.push(`/docker/${encodeURIComponent(container.name)}`)
                  }
                >
                  <span className="flex items-center gap-2">
                    <cMeta.Icon
                      className={cn("size-4 shrink-0", cMeta.iconClass)}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {container.name}
                    </span>
                    {container.updateAvailable && (
                      <Badge variant="warning" className="shrink-0 text-[10px]">
                        update
                      </Badge>
                    )}
                    {container.health === "unhealthy" && (
                      <Badge variant="destructive" className="shrink-0 gap-1 text-[10px]">
                        <TriangleAlert aria-hidden="true" /> unhealthy
                      </Badge>
                    )}
                  </span>
                  <span className="mt-1.5 grid grid-cols-3 gap-2 text-xs">
                    <span>
                      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                        State
                      </span>
                      <span className={cn(container.state === "RUNNING" ? "text-success" : "")}>
                        {cMeta.label}
                      </span>
                    </span>
                    <span>
                      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                        CPU
                      </span>
                      <span className="font-mono tabular-nums">
                        {container.state === "RUNNING" &&
                        container.metrics?.cpuPercent != null
                          ? formatPercent(container.metrics.cpuPercent)
                          : "—"}
                      </span>
                    </span>
                    <span>
                      <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                        Memory
                      </span>
                      <span className="font-mono tabular-nums">
                        {container.state === "RUNNING" &&
                        container.metrics?.memoryUsedBytes != null
                          ? formatBytes(container.metrics.memoryUsedBytes)
                          : "—"}
                      </span>
                    </span>
                  </span>
                  {container.composeProject && (
                    <span className="mt-1 block truncate text-[11px] text-muted-foreground">
                      {container.composeProject}
                    </span>
                  )}
                </button>
                {((dockerAction.caps?.docker.enabled && (dockerAction.caps.docker.start || dockerAction.caps.docker.stop)) && (
                  <div className="mt-2 flex items-center gap-2 border-t pt-2">
                    {dockerAction.phase?.id === container.id ? (
                      // Concise in-progress/timeout state replaces the buttons
                      // while a verified transition is pending (v0.9.9).
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 text-xs",
                          dockerAction.phase.timedOut ? "text-warning" : "text-muted-foreground",
                        )}
                        role="status"
                      >
                        {dockerAction.phase.timedOut ? (
                          <TriangleAlert className="size-3.5" aria-hidden="true" />
                        ) : (
                          <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
                        )}
                        {dockerAction.phase.label}
                      </span>
                    ) : (
                      <>
                        {container.state === "RUNNING" && dockerAction.caps.docker.stop && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 gap-1.5 text-xs"
                            disabled={dockerAction.posting}
                            aria-label={`Stop ${container.name}`}
                            onClick={() =>
                              dockerAction.begin({ id: container.id, name: container.name, action: "stop" })
                            }
                          >
                            <StopCircle className="size-3.5" aria-hidden="true" />
                            Stop
                          </Button>
                        )}
                        {(container.state === "EXITED" || container.state === "PAUSED") &&
                          dockerAction.caps.docker.start && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 gap-1.5 text-xs"
                              disabled={dockerAction.posting}
                              aria-label={`Start ${container.name}`}
                              onClick={() =>
                                dockerAction.begin({ id: container.id, name: container.name, action: "start" })
                              }
                            >
                              <PlayCircle className="size-3.5" aria-hidden="true" />
                              Start
                            </Button>
                          )}
                      </>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-7 text-xs"
                      aria-label={`Open details for ${container.name}`}
                      onClick={() => router.push(`/docker/${encodeURIComponent(container.name)}`)}
                    >
                      Details
                    </Button>
                  </div>
                ))}
              </Card>
            );
          })}
        </div>
        <div className="hidden md:block">
        {grouped.map((group) => (
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
            <Card className="hidden overflow-x-auto md:block">
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
                        onClick={() => router.push(`/docker/${encodeURIComponent(container.name)}`)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            router.push(`/docker/${encodeURIComponent(container.name)}`);
                          }
                        }}
                        aria-label={`Show details for ${container.name}`}
                        className={cn(
                          "cursor-pointer border-b last:border-0 hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                          compact ? "text-xs" : "",
                          "[contain-intrinsic-size:auto_44px] [content-visibility:auto]",
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
          ))}
        </div>
        </>
      )}
      </section>
      <section
        id="docker-updates"
        aria-label="Updates"
        tabIndex={-1}
        className={cn("mt-4 scroll-mt-20 outline-none", highlightSection === "updates" && "rounded-lg ring-2 ring-primary/40")}
      >
        <LazySection
          sectionKey="updates"
          open={Boolean(openSections.updates)}
          onOpenChange={(key, value) => setOpenSections((current) => ({ ...current, [key]: value }))}
          label="Updates"
          openHint="show"
          summary={updateSummaryText}
          highlight={highlightSection === "updates"}
        >
          <DockerUpdatesPanel />
        </LazySection>
      </section>

      <section
        id="docker-projects"
        aria-label="Projects"
        tabIndex={-1}
        className={cn("mt-4 scroll-mt-20 outline-none", highlightSection === "projects" && "rounded-lg ring-2 ring-primary/40")}
      >
        <LazySection
          sectionKey="projects"
          open={Boolean(openSections.projects)}
          onOpenChange={(key, value) => setOpenSections((current) => ({ ...current, [key]: value }))}
          label="Projects"
          openHint="show"
          highlight={highlightSection === "projects"}
        >
          <ComposeProjectsPanel />
        </LazySection>
      </section>

      <section
        id="docker-history"
        aria-label="History"
        tabIndex={-1}
        className={cn("mt-4 scroll-mt-20 outline-none", highlightSection === "history" && "rounded-lg ring-2 ring-primary/40")}
      >
        <LazySection
          sectionKey="history"
          open={Boolean(openSections.history)}
          onOpenChange={(key, value) => setOpenSections((current) => ({ ...current, [key]: value }))}
          label="History"
          openHint="show"
          highlight={highlightSection === "history"}
        >
          <UpdateHistoryPanel />
        </LazySection>
      </section>

      <ConfirmDialog
        open={dockerAction.pendingConfirm !== null}
        title={
          dockerAction.pendingConfirm
            ? `${dockerAction.pendingConfirm.action === "stop" ? "Stop" : "Start"} ${dockerAction.pendingConfirm.name}?`
            : ""
        }
        severity={dockerAction.pendingConfirm?.action === "stop" ? "destructive" : "info"}
        confirmLabel={dockerAction.pendingConfirm?.action === "stop" ? "Stop container" : "Start container"}
        busy={dockerAction.posting}
        onCancel={dockerAction.cancel}
        onConfirm={() => dockerAction.confirm()}
      >
        {dockerAction.pendingConfirm?.action === "stop" ? (
          <>
            <p>
              The container <strong>{dockerAction.pendingConfirm.name}</strong> is currently running.
            </p>
            <p>Stopping makes its service unavailable until started again.</p>
          </>
        ) : (
          <p>Will bring the container up with its existing configuration.</p>
        )}
      </ConfirmDialog>

      <p className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <Boxes className="size-3.5" aria-hidden="true" />
        Start/stop actions run confirmed through the guarded action API and are audit-logged; restart is not offered because the Unraid API exposes no verified restart.
        {showMetrics
          ? ` Runtime metrics from Prometheus (docker stats, 15s). Filters: high CPU ≥ ${HIGH_CPU_PERCENT}%, high memory ≥ ${formatBytes(HIGH_MEMORY_BYTES, 0)} or ≥ ${HIGH_MEMORY_PERCENT_OF_LIMIT}% of limit.`
          : " Runtime metrics unavailable — Prometheus not reachable."}
      </p>
    </div>
  );
}

/** Compact age formatter for the cached update summary ("18 min ago"). */
function formatAge(ageSeconds: number): string {
  if (ageSeconds < 90) return `${ageSeconds}s ago`;
  if (ageSeconds < 90 * 60) return `${Math.round(ageSeconds / 60)} min ago`;
  if (ageSeconds < 36 * 3600) return `${Math.round(ageSeconds / 3600)} h ago`;
  return `${Math.round(ageSeconds / 86400)} d ago`;
}
