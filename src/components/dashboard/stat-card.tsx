import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface StatCardProps {
  label: string;
  icon: LucideIcon;
  /** Top-line value, e.g. "48%". */
  value: string;
  /** Secondary detail line, e.g. "31.2 GB / 64 GB". */
  detail?: React.ReactNode;
  /** 0-100, when given a progress bar is shown. */
  percent?: number | null;
  iconClassName?: string;
}

export function StatCard({
  label,
  icon: Icon,
  value,
  detail,
  percent = null,
  iconClassName,
}: StatCardProps) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {label}
          </span>
          <span
            className={cn(
              "flex size-8 items-center justify-center rounded-md bg-secondary text-muted-foreground",
              iconClassName,
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </span>
        </div>
        <p className="font-mono text-2xl font-semibold tabular-nums">{value}</p>
        {percent !== null && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-all duration-500",
                percent >= 90
                  ? "bg-destructive"
                  : percent >= 75
                    ? "bg-warning"
                    : "bg-primary",
              )}
              style={{ width: `${Math.min(100, Math.max(0, percent))}%` }}
            />
          </div>
        )}
        {detail && <p className="text-xs text-muted-foreground">{detail}</p>}
      </CardContent>
    </Card>
  );
}

export function StatCardSkeleton() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-5">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="size-8 rounded-md" />
        </div>
        <Skeleton className="h-8 w-24" />
        <Skeleton className="h-3 w-32" />
      </CardContent>
    </Card>
  );
}
