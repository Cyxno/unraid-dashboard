import { Box, PauseCircle, PlayCircle, StopCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { DockerSummary } from "@/server/unraid/types";

const STATE_META = {
  RUNNING: { label: "Running", variant: "success" as const, Icon: PlayCircle },
  PAUSED: { label: "Paused", variant: "warning" as const, Icon: PauseCircle },
  EXITED: { label: "Stopped", variant: "muted" as const, Icon: StopCircle },
} as const;

export function DockerList({ docker, loading }: { docker: DockerSummary | null; loading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Docker containers</CardTitle>
        {docker && (
          <Badge variant="muted">
            {docker.running}/{docker.total} running
          </Badge>
        )}
      </CardHeader>
      <CardContent>
        {loading && !docker ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : docker ? (
          docker.containers.length === 0 ? (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              No Docker containers installed.
            </p>
          ) : (
            <ul className="divide-y">
              {docker.containers.map((container) => {
                const meta = STATE_META[container.state] ?? STATE_META.EXITED;
                return (
                  <li
                    key={container.id}
                    className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0"
                  >
                    <meta.Icon
                      className={
                        container.state === "RUNNING"
                          ? "size-4 shrink-0 text-success"
                          : container.state === "PAUSED"
                            ? "size-4 shrink-0 text-warning"
                            : "size-4 shrink-0 text-muted-foreground"
                      }
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
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {container.image}
                      </p>
                    </div>
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
                      {container.status}
                    </span>
                    <Badge variant={meta.variant} className="shrink-0">
                      {meta.label}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <p className="text-sm text-muted-foreground">Container data unavailable.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function DockerListEmptyHint() {
  return (
    <p className="flex items-center gap-2 text-xs text-muted-foreground">
      <Box className="size-3.5" aria-hidden="true" /> Full container management arrives with the
      Docker page.
    </p>
  );
}
