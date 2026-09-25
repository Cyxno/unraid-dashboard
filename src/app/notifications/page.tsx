"use client";

/* archive action wiring added in v0.5 */

import { useState } from "react";
import { AlertTriangle, BellRing } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { PAGE_INTERVAL_MS } from "@/lib/prefs";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { SectionStatus } from "@/components/dashboard/section-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Archive } from "lucide-react";
import type { DashboardNotification, Section } from "@/lib/api-types";
import { useActionCapabilities, useActionRunner } from "@/components/actions/use-actions";
import { ConfirmDialog } from "@/components/actions/confirm-dialog";
import type { ActionResponseBody } from "@/lib/api-types";

type TypeFilter = "UNREAD" | "ARCHIVE";
type ImportanceFilter = "all" | "INFO" | "WARNING" | "ALERT";

export default function NotificationsPage() {
  const [type, setType] = useState<TypeFilter>("UNREAD");
  const [importance, setImportance] = useState<ImportanceFilter>("all");
  const [pendingArchive, setPendingArchive] = useState<DashboardNotification | null>(null);
  const [archiveResult, setArchiveResult] = useState<ActionResponseBody | null>(null);
  const { capabilities } = useActionCapabilities();
  const { runAction, pending } = useActionRunner();
  const archiveAvailable =
    (capabilities?.enabled ?? false) && capabilities?.notification.includes("archive");

  const archive = async (notification: DashboardNotification) => {
    setPendingArchive(null);
    const result = await runAction({
      kind: "notification",
      action: "archive",
      id: notification.id,
    });
    setArchiveResult(result);
  };

  const params = new URLSearchParams({ type, limit: "100" });
  if (importance !== "all") params.set("importance", importance);

  const { data, error, loading } = usePoll<Section<DashboardNotification[]>>(
    `/api/notifications?${params.toString()}`,
    PAGE_INTERVAL_MS.notifications,
  );
  const notifications = data?.data ?? [];

  return (
    <div>
      <PageHeader
        title="Notifications"
        description="Unraid notification feed (read-only)"
        actions={
          <SectionStatus
            section={
              data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }
            }
          />
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Notification type" className="flex items-center gap-1">
          {(["UNREAD", "ARCHIVE"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={type === option ? "secondary" : "ghost"}
              aria-pressed={type === option}
              onClick={() => setType(option)}
              className="h-7 px-2.5 text-xs capitalize"
            >
              {option.toLowerCase()}
            </Button>
          ))}
        </div>
        <div role="group" aria-label="Severity filter" className="flex items-center gap-1">
          {(["all", "ALERT", "WARNING", "INFO"] as const).map((option) => (
            <Button
              key={option}
              size="sm"
              variant={importance === option ? "secondary" : "ghost"}
              aria-pressed={importance === option}
              onClick={() => setImportance(option)}
              className="h-7 px-2.5 text-xs capitalize"
            >
              {option.toLowerCase()}
            </Button>
          ))}
        </div>
      </div>

      {loading && notifications.length === 0 ? (
        <LoadingPanel rows={6} />
      ) : error && !data ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        >
          Notifications unavailable: {error}
        </p>
      ) : notifications.length === 0 ? (
        <p className="flex items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
          <BellRing className="size-4" aria-hidden="true" />
          No {type.toLowerCase()} notifications
          {importance !== "all" ? ` with severity ${importance.toLowerCase()}` : ""}.
        </p>
      ) : (
        <Card>
          <CardContent className="pt-4">
            <ul className="divide-y">
              {notifications.map((event, index) => {
                const isAlert = event.importance === "ALERT";
                const isWarning = event.importance === "WARNING";
                return (
                  <li
                    key={event.id}
                    className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <AlertTriangle
                      className={
                        isAlert
                          ? "mt-0.5 size-4 shrink-0 text-destructive"
                          : isWarning
                            ? "mt-0.5 size-4 shrink-0 text-warning"
                            : "mt-0.5 size-4 shrink-0 text-muted-foreground"
                      }
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{event.subject}</p>
                      <p className="text-xs text-muted-foreground">{event.description}</p>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {event.title} · {event.timestamp ?? "unknown time"}
                      </p>
                    </div>
                    <Badge
                      variant={
                        isAlert ? "destructive" : isWarning ? "warning" : "muted"
                      }
                      className="shrink-0 text-[10px]"
                    >
                      {event.importance.toLowerCase()}
                    </Badge>
                    <Badge variant="muted" className="hidden shrink-0 text-[10px] sm:inline-flex">
                      {event.type.toLowerCase()}
                    </Badge>
                    {type === "UNREAD" && archiveAvailable && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 shrink-0 gap-1 text-xs"
                        disabled={pending !== null}
                        aria-label={`Archive notification: ${event.subject}`}
                        onClick={() => setPendingArchive(event)}
                      >
                        <Archive className="size-3.5" aria-hidden="true" />
                        Archive
                      </Button>
                    )}
                    <span className="sr-only">index {index}</span>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}
      <p className="mt-4 text-[11px] text-muted-foreground">
        Read-only: marking notifications as read/archiving is not exposed by the
        dashboard to keep the API key strictly observational.
      </p>
    </div>
  );
}
