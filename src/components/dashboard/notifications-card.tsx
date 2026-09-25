"use client";

import Link from "next/link";
import { AlertTriangle, BellOff } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { SectionStatus } from "./section-status";
import type { NotificationsSummary, Section } from "@/lib/api-types";

const IMPORTANCE_META = {
  ALERT: { badge: "destructive" as const, iconClass: "text-destructive" },
  WARNING: { badge: "warning" as const, iconClass: "text-warning" },
  INFO: { badge: "muted" as const, iconClass: "text-muted-foreground" },
} as const;

export function NotificationsCard({
  notifications,
}: {
  notifications: Section<NotificationsSummary>;
}) {
  const data = notifications.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent events</CardTitle>
        {data && (
          <div className="flex gap-1.5">
            {data.unreadCounts.alert > 0 && (
              <Badge variant="destructive">{data.unreadCounts.alert} alerts</Badge>
            )}
            {data.unreadCounts.warning > 0 && (
              <Badge variant="warning">{data.unreadCounts.warning} warnings</Badge>
            )}
            {data.unreadCounts.info > 0 && (
              <Badge variant="muted">{data.unreadCounts.info} info</Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        <SectionStatus section={notifications} className="mb-2" />
        {!data ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : data.recent.length === 0 ? (
          <p className="flex items-center justify-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
            <BellOff className="size-4" aria-hidden="true" /> No unread warnings or
            alerts.
          </p>
        ) : (
          <ul className="space-y-2">
            {data.recent.map((event) => {
              const meta = IMPORTANCE_META[event.importance];
              return (
                <li
                  key={event.id}
                  className="flex items-start gap-3 rounded-md border p-3"
                >
                  <AlertTriangle
                    className={
                      event.importance === "INFO"
                        ? "mt-0.5 hidden"
                        : `mt-0.5 size-4 shrink-0 ${meta.iconClass}`
                    }
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{event.subject}</p>
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {event.description}
                    </p>
                  </div>
                  <Badge variant={meta.badge} className="shrink-0 text-[10px]">
                    {event.importance.toLowerCase()}
                  </Badge>
                  {event.timestamp && (
                    <time className="hidden shrink-0 text-xs text-muted-foreground md:inline">
                      {event.timestamp}
                    </time>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          <Link href="/notifications" className="underline-offset-2 hover:underline">
            All notifications
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
