import { cn } from "@/lib/utils";
import type { StatusTone } from "@/components/ui/status";

/**
 * Storage health language (v0.9.1): ONE mapping from Unraid's raw disk
 * color/state values to the product's semantic status tones. Every
 * Storage surface (hero, table, cards, NOC) resolves through these two
 * functions — no raw red/green ad-hoc styling anywhere.
 */

export interface DiskHealthInput {
  state: string;
  fsColor: string | null;
}

/**
 * Maps a disk's Unraid state + color ball to a semantic tone.
 * Priority: explicit disable/invalid > color ball > state fallback.
 */
export function diskHealthTone(disk: DiskHealthInput): StatusTone {
  const state = disk.state.toUpperCase();
  if (state === "DISK_DSBL" || state === "DISK_INVALID" || state === "DISK_NEW") return "critical";
  const color = (disk.fsColor ?? "").toUpperCase();
  if (color === "RED" || color === "RED_BALL") return "critical";
  if (color === "YELLOW") return "warning";
  if (color === "GREY") return "offline";
  if (state === "DISK_OK") return "healthy";
  return "warning";
}

export function diskHealthLabel(disk: DiskHealthInput): string {
  const tone = diskHealthTone(disk);
  if (tone === "critical") {
    const state = disk.state.toUpperCase();
    if (state === "DISK_INVALID") return "Invalid";
    if (state === "DISK_DSBL") return "Disabled";
    if (state === "DISK_NEW") return "New (unassigned)";
    return "Fault";
  }
  if (tone === "warning") {
    const state = disk.state.toUpperCase();
    if (state === "DISK_NP") return "No parity";
    return "Warning";
  }
  if (tone === "offline") return "Standby";
  return "Healthy";
}

/** Overall array verdict: the worst disk tone + array state. */
export function arrayHealthTone(state: string, disks: DiskHealthInput[]): StatusTone {
  if (state.toUpperCase() !== "STARTED") return "offline";
  const tones = disks.map((disk) => diskHealthTone(disk));
  if (tones.includes("critical")) return "critical";
  if (tones.includes("warning")) return "warning";
  return "healthy";
}

export function arrayHealthLabel(state: string): string {
  switch (state.toUpperCase()) {
    case "STARTED":
      return "Array started";
    case "STOPPED":
      return "Array stopped";
    case "MOUNTING":
      return "Array mounting";
    default:
      return `Array ${state.toLowerCase()}`;
  }
}

/** Utilization bar color: semantic thresholds (75% warn, 90% critical). */
export function utilizationToneClass(percent: number | null): string {
  if (percent === null) return "bg-muted-foreground";
  if (percent >= 90) return "bg-danger";
  if (percent >= 75) return "bg-warning";
  return "bg-primary";
}

/** Temperature verdict (Unraid disk ranges): >45 warn, >50 critical. */
export function diskTempTone(tempC: number | null): StatusTone | null {
  if (tempC === null) return null;
  if (tempC >= 50) return "critical";
  if (tempC >= 45) return "warning";
  return "healthy";
}

/** CSS class for a segmented capacity bar segment. */
export function CapacityBar({
  segments,
  className,
}: {
  /** Ordered segments: [{percent, className, label}] — widths sum ≤ 100. */
  segments: Array<{ percent: number; className: string; label: string }>;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={segments.map((segment) => `${segment.label} ${segment.percent.toFixed(0)}%`).join(", ")}
      className={cn("flex h-2.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      {segments
        .filter((segment) => segment.percent > 0)
        .map((segment, index) => (
          <div
            key={`${segment.label}-${index}`}
            className={cn("h-full", segment.className)}
            style={{ width: `${Math.min(100, segment.percent)}%` }}
          />
        ))}
    </div>
  );
}
