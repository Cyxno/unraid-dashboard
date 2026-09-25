import type { LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card } from "@/components/ui/card";
import { SectionStatus, LastUpdated } from "./section-status";
import { cn } from "@/lib/utils";
import type { Section } from "@/lib/api-types";

interface MetricCardProps {
  label: string;
  icon: LucideIcon;
  section: Section<unknown>;
  /** Top-line value, e.g. "48%". */
  value: string;
  /** Secondary context line(s). */
  detail?: React.ReactNode;
  /** 0-100, renders a color-coded bar when provided. */
  percent?: number | null;
  /** Mini content rendered under the value (e.g. sparkline). */
  children?: React.ReactNode;
  iconClassName?: string;
}

export function MetricCard({
  label,
  icon: Icon,
  section,
  value,
  detail,
  percent = null,
  children,
  iconClassName,
}: MetricCardProps) {
  const unavailable = section.data === null;
  return (
    <Card className="gap-0 p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="flex items-center gap-1.5">
          <SectionStatus section={section} compact />
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-md bg-secondary/70 text-muted-foreground",
              iconClassName,
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </span>
        </span>
      </div>
      {unavailable ? (
        <div className="mt-3 space-y-1.5">
          <Skeleton className="h-7 w-20" />
          <p className="text-xs text-muted-foreground">
            {section.status === "demo" ? "Demo data unavailable" : "No data"}
          </p>
        </div>
      ) : (
        <>
          <p className="mt-2 font-mono text-[26px] font-semibold leading-tight tabular-nums">
            {value}
          </p>
          {percent !== null && (
            <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
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
          {children}
          {detail && (
            <div className="mt-2 text-xs text-muted-foreground">{detail}</div>
          )}
        </>
      )}
      <div className="mt-1.5 h-3">
        <LastUpdated section={section} />
      </div>
    </Card>
  );
}

export function MetricCardSkeleton() {
  return (
    <Card className="gap-0 p-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="size-7 rounded-md" />
      </div>
      <Skeleton className="mt-3 h-7 w-24" />
      <Skeleton className="mt-2 h-1.5 w-full" />
      <Skeleton className="mt-2 h-3 w-28" />
    </Card>
  );
}
