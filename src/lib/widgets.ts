import { z } from "zod";

/**
 * Shared-dashboard widget registry (v0.7).
 *
 * The registry is the single source of truth for which widgets a shared
 * dashboard may contain. Server-side validation and the client renderer
 * both import it — arbitrary component/config injection is impossible:
 * a widget id outside this list is rejected at the API boundary, and
 * sizes are limited to the predefined span set.
 */

export const WIDGET_IDS = [
  "health",
  "cpu",
  "memory",
  "thermal",
  "storage",
  "docker",
  "top-cpu",
  "top-memory",
  "network",
  "disk-io",
  "notifications",
  "audit",
] as const;

export type WidgetId = (typeof WIDGET_IDS)[number];

/** Predefined grid spans on the 3-column desktop grid. */
export const WIDGET_SIZES = ["sm", "md", "lg"] as const;
export type WidgetSize = (typeof WIDGET_SIZES)[number];

/** Human labels for the editor (never shown inside widgets). */
export const WIDGET_LABELS: Record<WidgetId, string> = {
  health: "System health & uptime",
  cpu: "CPU",
  memory: "Memory",
  thermal: "Thermal",
  storage: "Array & storage",
  docker: "Docker containers",
  "top-cpu": "Top CPU containers",
  "top-memory": "Top memory containers",
  network: "Network",
  "disk-io": "Disk I/O",
  notifications: "Notifications",
  audit: "Recent audit events",
};

export const widgetIdSchema = z.enum(WIDGET_IDS);
export const widgetSizeSchema = z.enum(WIDGET_SIZES);

export const widgetEntrySchema = z
  .object({
    id: widgetIdSchema,
    size: widgetSizeSchema.default("sm"),
  })
  .strict();

export const widgetLayoutSchema = z
  .array(widgetEntrySchema)
  .min(1)
  .max(12)
  .refine((widgets) => widgets.length === new Set(widgets.map((w) => w.id)).size, {
    message: "duplicate widget ids",
  });

export type WidgetEntry = z.infer<typeof widgetEntrySchema>;

/** Default layout for a fresh dashboard (v2). */
export const DEFAULT_WIDGETS: WidgetEntry[] = [
  { id: "cpu", size: "sm" },
  { id: "memory", size: "sm" },
  { id: "health", size: "sm" },
  { id: "storage", size: "md" },
  { id: "network", size: "sm" },
  { id: "docker", size: "md" },
];

/** v1 → v2 widget migration (old overview ids → registry ids). */
export const V1_WIDGET_MAP: Record<string, { id: WidgetId; size: WidgetSize }> = {
  cpu: { id: "cpu", size: "sm" },
  memory: { id: "memory", size: "sm" },
  uptime: { id: "health", size: "sm" },
  array: { id: "storage", size: "md" },
  network: { id: "network", size: "sm" },
  docker: { id: "docker", size: "md" },
};

/** CSS grid span classes per size on the xl 3-column grid. */
export const SIZE_SPAN: Record<WidgetSize, string> = {
  sm: "xl:col-span-1",
  md: "xl:col-span-2",
  lg: "xl:col-span-3",
};
