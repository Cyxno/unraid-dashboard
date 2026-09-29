/**
 * NOC widget registry (v0.9.3): normalized definitions for every built-in
 * NOC widget. The NOC page renders from this registry + the persisted
 * layout config (prefs.nocWidgets / nocWidgetSizes) — no ad-hoc tiles.
 *
 * Each entry: id, title, default order position, allowed sizes, and the
 * layout presets that seed configurations. Data comes from the same
 * /api/overview + /api/system-snapshot polls the NOC page already runs.
 */

export type NocWidgetSize = "1x1" | "2x1" | "2x2";

export interface NocWidgetDef {
  id: string;
  title: string;
  /** Default position in the full layout (lower = earlier). */
  order: number;
  allowedSizes: NocWidgetSize[];
}

export const NOC_WIDGETS: NocWidgetDef[] = [
  { id: "cpu", title: "CPU", order: 10, allowedSizes: ["1x1", "2x2"] },
  { id: "ram", title: "RAM", order: 20, allowedSizes: ["1x1", "2x2"] },
  { id: "temp", title: "Package temp", order: 30, allowedSizes: ["1x1", "2x2"] },
  { id: "array", title: "Array", order: 40, allowedSizes: ["1x1", "2x2"] },
  { id: "docker", title: "Docker", order: 50, allowedSizes: ["1x1", "2x2"] },
  { id: "ntrx", title: "Net RX", order: 60, allowedSizes: ["1x1"] },
  { id: "ntxt", title: "Net TX", order: 70, allowedSizes: ["1x1"] },
  { id: "load", title: "Load 5", order: 80, allowedSizes: ["1x1", "2x2"] },
  { id: "topcpu", title: "Top CPU consumers", order: 90, allowedSizes: ["2x1", "2x2"] },
  { id: "diskio", title: "Disk throughput", order: 100, allowedSizes: ["2x1", "2x2"] },
];

export const NOC_WIDGET_IDS = NOC_WIDGETS.map((widget) => widget.id);

export function nocWidgetDef(id: string): NocWidgetDef | null {
  return NOC_WIDGETS.find((widget) => widget.id === id) ?? null;
}

/** Layout presets seed the widget config (order = ids, sizes default). */
export const NOC_LAYOUT_SEEDS: Record<string, string[]> = {
  full: [...NOC_WIDGET_IDS],
  performance: ["cpu", "ram", "load", "temp", "topcpu", "ntrx", "ntxt", "array", "docker"],
  storage: ["array", "diskio", "temp", "ram", "cpu"],
  containers: ["docker", "cpu", "ram", "topcpu", "temp"],
  minimal: ["cpu", "ram", "array", "temp"],
};

/** Validates + normalizes a persisted widget layout (migration-safe). */
export function normalizeNocLayout(input: unknown): { order: string[]; sizes: Record<string, NocWidgetSize> } {
  const fallback = { order: [...NOC_WIDGET_IDS], sizes: {} as Record<string, NocWidgetSize> };
  if (typeof input !== "object" || input === null) return fallback;
  const raw = input as { order?: unknown; sizes?: unknown };
  if (!Array.isArray(raw.order) || raw.order.length === 0) return fallback;
  const known = new Set(NOC_WIDGET_IDS);
  const order = raw.order.filter((id): id is string => typeof id === "string" && known.has(id));
  if (order.length === 0) return fallback;
  const sizes: Record<string, NocWidgetSize> = {};
  if (typeof raw.sizes === "object" && raw.sizes !== null) {
    for (const [id, size] of Object.entries(raw.sizes as Record<string, unknown>)) {
      if (known.has(id) && (size === "1x1" || size === "2x1" || size === "2x2")) sizes[id] = size;
    }
  }
  return { order, sizes };
}
