import type { SharedDashboardDto } from "@/lib/api-types";

/**
 * Maps a v2 shared-dashboard widget list onto the local overview order
 * (the six overview card ids) for saved-view interop: registry widgets
 * outside the overview set are ignored — local views stay a snapshot of
 * the six summary cards.
 */
export function widgetsToOverviewOrder(widgets: SharedDashboardDto["widgets"]): string[] {
  const known = ["cpu", "memory", "health", "storage", "network", "docker"] as const;
  const aliases: Record<string, string> = { health: "uptime", storage: "array" };
  const order: string[] = [];
  for (const widget of widgets) {
    const base = aliases[widget.id] ?? widget.id;
    if ((known as readonly string[]).includes(widget.id) && !order.includes(base)) {
      order.push(base);
    }
  }
  return order;
}
