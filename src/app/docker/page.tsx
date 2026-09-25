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
import { PAGE_INTERVAL_MS, usePrefs } from "@/lib/prefs";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { SectionStatus } from "@/components/dashboard/section-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
  ContainerHealth,
  DockerContainerSummary,
  DockerSummary,
  Section,
} from "@/lib/api-types";

type StatusFilter = "all" | "running" | "stopped" | "unhealthy" | "update";
type SortKey = "name" | "state" | "status";

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

function ContainerDetail({
  container,
  onClose,
}: {
  container: DockerContainerSummary;
  onClose: () => void;
}) {
  const meta = STATE_META[container.state] ?? STATE_META.EXITED;
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
        <dl className="space-y-3">
          {rows.map(([label, value]) => (
            <div
              key={label}
              className="grid grid-cols-[120px_1fr] gap-2 text-sm"
            >
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
  const [selected, setSelected] = useState<string | null>(null);

  const containers = useMemo(
    () => data?.data?.containers ?? [],
    [data],
  );

  const visible = useMemo(() => {
    let list = containers;
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (container) =>
          container.name.toLowerCase().includes(q) ||
          container.image.toLowerCase().includes(q),
      );
    }
    if (filter === "running") list = list.filter((c) => c.state === "RUNNING");
    if (filter === "stopped") list = list.filter((c) => c.state === "EXITED");
    if (filter === "unhealthy")
      list = list.filter((c) => c.health === "unhealthy");
    if (filter === "update") list = list.filter((c) => c.updateAvailable);
    const sorted = [...list].sort((a, b) => {
      const va = a[sortKey].toLowerCase();
      const vb = b[sortKey].toLowerCase();
      return sortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    });
    return sorted;
  }, [containers, query, filter, sortKey, sortAsc]);

  const selectedContainer =
    containers.find((container) => container.id === selected) ?? null;

  const compact = prefs.density === "compact";

  return (
    <div>
      <PageHeader
        title="Docker"
        description={
          data?.data
            ? `${data.data.running} of ${data.data.total} containers running`
            : "Containers and their status"
        }
        actions={
          <SectionStatus
            section={
              data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }
            }
          />
        }
      />

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
            placeholder="Search name or image…"
            className="h-9 w-56 rounded-md border bg-card pl-8 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>

        <div role="group" aria-label="Filter containers" className="flex items-center gap-1">
          <Filter className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {(["all", "running", "stopped", "unhealthy", "update"] as const).map(
            (option) => (
              <Button
                key={option}
                size="sm"
                variant={filter === option ? "secondary" : "ghost"}
                aria-pressed={filter === option}
                onClick={() => setFilter(option)}
                className="h-7 px-2.5 text-xs capitalize"
              >
                {option}
              </Button>
            ),
          )}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              if (sortKey === "name") setSortAsc((v) => !v);
              else {
                setSortKey("name");
                setSortAsc(true);
              }
            }}
            aria-label={`Sort by name, currently ${sortAsc ? "ascending" : "descending"}`}
          >
            Name {sortKey === "name" ? (sortAsc ? "↑" : "↓") : ""}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2.5 text-xs"
            onClick={() => {
              if (sortKey === "state") setSortAsc((v) => !v);
              else {
                setSortKey("state");
                setSortAsc(true);
              }
            }}
            aria-label="Sort by state"
          >
            State {sortKey === "state" ? (sortAsc ? "↑" : "↓") : ""}
          </Button>
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
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <caption className="sr-only">Docker containers</caption>
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th scope="col" className="px-4 py-2.5 font-medium">Container</th>
                <th scope="col" className="px-4 py-2.5 font-medium">State</th>
                <th scope="col" className={cn("px-4 py-2.5 font-medium", compact && "hidden sm:table-cell")}>Status</th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium md:table-cell">Ports</th>
                <th scope="col" className="hidden px-4 py-2.5 font-medium lg:table-cell">Image</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((container) => {
                const meta = STATE_META[container.state] ?? STATE_META.EXITED;
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
                      {!compact && (
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
      )}

      {selectedContainer && (
        <ContainerDetail container={selectedContainer} onClose={() => setSelected(null)} />
      )}

      <p className="mt-4 flex items-center gap-2 text-[11px] text-muted-foreground">
        <Boxes className="size-3.5" aria-hidden="true" />
        Read-only view — container actions are intentionally out of scope.
      </p>
    </div>
  );
}
