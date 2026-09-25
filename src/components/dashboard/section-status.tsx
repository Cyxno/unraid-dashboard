import { CircleAlert, DatabaseZap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn, formatAge } from "@/lib/utils";
import type { Section } from "@/lib/api-types";

const STATUS_META = {
  live: { label: "Live", variant: "success" as const },
  stale: { label: "Stale", variant: "warning" as const },
  unavailable: { label: "Unavailable", variant: "destructive" as const },
  demo: { label: "Demo", variant: "warning" as const },
} as const;

/**
 * Data-provenance badge. Status is communicated with text (not color alone)
 * and stale/unavailable sections expose the underlying reason on hover/focus.
 */
export function SectionStatus({
  section,
  className,
  compact = false,
}: {
  section: Section<unknown>;
  className?: string;
  compact?: boolean;
}) {
  const meta = STATUS_META[section.status];
  const title =
    section.reason ??
    (section.status === "stale"
      ? `Last good data from ${formatAge(section.ageMs)}`
      : undefined);
  return (
    <span
      title={title ?? undefined}
      className={cn("inline-flex items-center gap-1", className)}
    >
      {section.status !== "live" && (
        <Badge variant={meta.variant} className="gap-1">
          {section.status === "stale" ? (
            <CircleAlert aria-hidden="true" />
          ) : section.status === "demo" ? (
            <DatabaseZap aria-hidden="true" />
          ) : (
            <CircleAlert aria-hidden="true" />
          )}
          {compact ? meta.label : meta.label}
        </Badge>
      )}
    </span>
  );
}

export function LastUpdated({ section }: { section: Section<unknown> }) {
  if (section.status === "live") return null;
  return (
    <span className="text-[11px] text-muted-foreground">
      {section.status === "stale"
        ? `last good ${formatAge(section.ageMs)}`
        : "no data yet"}
    </span>
  );
}
