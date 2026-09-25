"use client";

import Link from "next/link";
import { Boxes, PauseCircle, PlayCircle, StopCircle, TriangleAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionStatus } from "./section-status";
import { cn } from "@/lib/utils";
import type { ContainerHealth, DockerSummary, Section } from "@/lib/api-types";

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

/** Compact Docker card for the overview page; full table lives on /docker. */
export function DockerOverviewList({ docker }: { docker: Section<DockerSummary> }) {
  const data = docker.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Docker containers
          {data && (
            <Badge variant="muted">
              {data.running}/{data.total} running
            </Badge>
          )}
        </CardTitle>
        <SectionStatus section={docker} />
      </CardHeader>
      <CardContent>
        {!data ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, index) => (
              <Skeleton key={index} className="h-9 w-full" />
            ))}
          </div>
        ) : data.containers.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            No Docker containers installed.
          </p>
        ) : (
          <ul className="divide-y">
            {data.containers.slice(0, 8).map((container) => {
              const meta = STATE_META[container.state] ?? STATE_META.EXITED;
              return (
                <li
                  key={container.id}
                  className="flex items-center gap-3 py-2 first:pt-0 last:pb-0"
                >
                  <meta.Icon
                    className={cn(
                      "size-4 shrink-0",
                      meta.iconClass,
                    )}
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">
                      {container.name}
                      {container.updateAvailable && (
                        <Badge variant="warning" className="text-[10px]">
                          update
                        </Badge>
                      )}
                      {healthBadge(container.health)}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {container.image}
                    </p>
                  </div>
                  <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                    {container.status}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 flex items-center gap-2 text-[11px] text-muted-foreground">
          <Boxes className="size-3.5" aria-hidden="true" />
          <Link href="/docker" className="underline-offset-2 hover:underline">
            All containers, search and filters
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
