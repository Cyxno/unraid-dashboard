import { cn } from "@/lib/utils";

/**
 * Semantic status language (v0.9.0): ONE component for state color across
 * the product. Themes supply the colors; this component never hardcodes.
 *
 *   healthy  → subtle success      warning → amber
 *   critical → red                 info    → blue/accent
 *   offline  → muted/desaturated
 */

export type StatusTone = "healthy" | "warning" | "critical" | "info" | "offline";

const DOT_CLASS: Record<StatusTone, string> = {
  healthy: "bg-success",
  warning: "bg-warning",
  critical: "bg-danger",
  info: "bg-info",
  offline: "bg-offline",
};

const TEXT_CLASS: Record<StatusTone, string> = {
  healthy: "text-success",
  warning: "text-warning",
  critical: "text-danger",
  info: "text-info",
  offline: "text-offline-foreground",
};

export function StatusDot({
  tone,
  pulse = false,
  className,
  label,
}: {
  tone: StatusTone;
  /** Gentle live pulse; suppressed by data-motion="reduced" + OS setting. */
  pulse?: boolean;
  className?: string;
  label?: string;
}) {
  return (
    <span
      role="status"
      aria-label={label}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        DOT_CLASS[tone],
        pulse && "animate-pulse",
        className,
      )}
    />
  );
}

export function statusTextClass(tone: StatusTone): string {
  return TEXT_CLASS[tone];
}
