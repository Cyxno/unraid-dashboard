import { cn } from "@/lib/utils";

/**
 * Beacon product mark (v0.9.0): a geometric lighthouse — tapered tower,
 * lamp, one sweeping beam and a ground line. Reads at 16px, works in
 * monochrome (currentColor) and adapts to themes through CSS variables.
 * Not derived from the Unraid logo or any existing brand.
 */

export function BeaconMark({
  className,
  variant = "color",
  title = "Beacon",
}: {
  className?: string;
  /** color = branded tile (accent beam on dark tile); mono = currentColor. */
  variant?: "color" | "mono";
  title?: string;
}) {
  const tower = "#e8eaf0";
  const lamp = "#f5c542";
  return (
    <svg
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      className={cn("shrink-0", className)}
    >
      {variant === "color" && (
        <>
          <rect x="2" y="2" width="60" height="60" rx="14" fill="oklch(0.22 0.02 250)" />
          <rect x="2" y="2" width="60" height="60" rx="14" fill="none" stroke="oklch(0.72 0.13 155 / 35%)" strokeWidth="2" />
        </>
      )}
      {/* beam: wide sweep from the lamp to the upper right */}
      <path
        d="M40 18 L58 10 L58 26 Z"
        fill={variant === "color" ? "oklch(0.85 0.09 90 / 75%)" : "currentColor"}
        opacity={variant === "color" ? 1 : 0.55}
      />
      {/* lamp */}
      <circle cx="36" cy="19" r="4" fill={variant === "color" ? lamp : "currentColor"} />
      {/* tapered tower */}
      <path
        d="M27 24 L37 24 L41 50 L23 50 Z"
        fill={variant === "color" ? tower : "currentColor"}
      />
      {/* tower window band */}
      <rect
        x={variant === "color" ? 27.8 : 28.5}
        y="34"
        width={variant === "color" ? 8.4 : 7}
        height="4"
        rx="1.4"
        fill={variant === "color" ? "oklch(0.22 0.02 250)" : "oklch(0.22 0.02 250 / 55%)"}
      />
      {/* ground line */}
      <rect
        x="16"
        y="50"
        width="32"
        height="3.5"
        rx="1.75"
        fill={variant === "color" ? tower : "currentColor"}
        opacity={variant === "color" ? 1 : 0.85}
      />
    </svg>
  );
}
