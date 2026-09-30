"use client";

import { cn } from "@/lib/utils";

/**
 * Shared layout primitives (v0.9.7). Pages compose these instead of
 * inventing their own grid/spacing rules, so vertical rhythm and column
 * behavior are systemic rather than per-page.
 *
 * Core policies:
 * - Cards size to their content. The only intentional fixed heights are
 *   chart canvases (chart readability) and skeleton placeholders
 *   (layout stability).
 * - Columns flow independently: AdaptiveColumns uses items-start so a
 *   short column is never stretched to a taller sibling (no dead space).
 * - Gaps come from the spacing tokens in globals.css (@theme inline):
 *   `gap-page` / `gap-section` / `gap-card`. No mt-12/mb-16-style magic.
 */

/** Page-level vertical stack: the root flow of a page. */
export function PageStack({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex flex-col gap-page", className)}>{children}</div>;
}

/** Stack of related cards/sections inside one region. */
export function SectionStack({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("flex flex-col gap-card", className)}>{children}</div>;
}

/**
 * Two independently-flowing columns on md+, a single natural stack on
 * phones. items-start prevents grid stretch: each column ends where its
 * content ends — no equal-height dead space. DOM order is left then
 * right, which keeps the logical reading order on mobile.
 */
export function AdaptiveColumns({
  left,
  right,
  className,
}: {
  left: React.ReactNode;
  right: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid items-start gap-card md:grid-cols-2", className)}>
      <SectionStack className="min-w-0">{left}</SectionStack>
      <SectionStack className="min-w-0">{right}</SectionStack>
    </div>
  );
}

/** Metric card grid used by the overview resource summary. */
export function MetricGrid({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("grid grid-cols-1 gap-card sm:grid-cols-2 xl:grid-cols-3", className)}>
      {children}
    </div>
  );
}

/** Section header rule ("TITLE ———") with token spacing. */
export function SectionRule({ label, className }: { label: string; className?: string }) {
  return (
    <div className={cn("flex items-center gap-3", className)} role="separator" aria-label={label}>
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</h3>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
