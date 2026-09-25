import { AlertTriangle, BellOff, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { NotificationsSummary } from "@/server/unraid/types";

const IMPORTANCE_META = {
  ALERT: { variant: "destructive" as const, Icon: AlertTriangle, label: "Alert" },
  WARNING: { variant: "warning" as const, Icon: AlertTriangle, label: "Warning" },
  INFO: { variant: "muted" as const, Icon: Info, label: "Info" },
} as const;

export function NotificationsCard({
  notifications,
  loading,
}: {
  notifications: NotificationsSummary | null;
  loading: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent events</CardTitle>
        {notifications && (
          <div className="flex gap-1.5">
            {notifications.unreadCounts.alert > 0 && (
              <Badge variant="destructive">{notifications.unreadCounts.alert} alerts</Badge>
            )}
            {notifications.unreadCounts.warning > 0 && (
              <Badge variant="warning">{notifications.unreadCounts.warning} warnings</Badge>
            )}
            {notifications.unreadCounts.info > 0 && (
              <Badge variant="muted">{notifications.unreadCounts.info} info</Badge>
            )}
          </div>
        )}
      </CardHeader>
      <CardContent>
        {loading && !notifications ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, index) => (
              <Skeleton key={index} className="h-12 w-full" />
            ))}
          </div>
        ) : notifications ? (
          notifications.recent.length === 0 ? (
            <p className="flex items-center justify-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
              <BellOff className="size-4" aria-hidden="true" /> No unread warnings or alerts.
            </p>
          ) : (
            <ul className="space-y-2">
              {notifications.recent.map((event) => {
                const meta = IMPORTANCE_META[event.importance];
                return (
                  <li
                    key={event.id}
                    className="flex items-start gap-3 rounded-md border p-3"
                  >
                    <meta.Icon
                      className={
                        event.importance === "ALERT"
                          ? "mt-0.5 size-4 shrink-0 text-destructive"
                          : event.importance === "WARNING"
                            ? "mt-0.5 size-4 shrink-0 text-warning"
                            : "mt-0.5 size-4 shrink-0 text-muted-foreground"
                      }
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{event.subject}</p>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {event.description}
                      </p>
                    </div>
                    {event.timestamp && (
                      <time className="shrink-0 text-xs text-muted-foreground">
                        {event.timestamp}
                      </time>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        ) : (
          <p className="text-sm text-muted-foreground">Notifications unavailable.</p>
        )}
      </CardContent>
    </Card>
  );
}
