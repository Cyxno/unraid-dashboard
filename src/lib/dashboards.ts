"use client";

import type {
  DashboardImportResult,
  DashboardListPayload,
  SharedDashboardDto,
} from "@/lib/api-types";
import type { SavedView } from "@/lib/prefs";
import { DEFAULT_WIDGETS } from "@/lib/widgets";
import { widgetsToOverviewOrder } from "@/lib/widget-utils";

/**
 * Client helpers for shared (server-persisted) dashboards.
 * All mutation endpoints are CSRF-guarded POST/PUT/DELETE with JSON
 * bodies — same rules as lifecycle actions.
 */

export interface DashboardWriteInput {
  name: string;
  widgets: SharedDashboardDto["widgets"];
  preferences: SharedDashboardDto["preferences"];
  access: SharedDashboardDto["access"];
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(body?.error ?? `Request failed (HTTP ${response.status})`);
  }
  return body as T;
}

export async function fetchDashboards(): Promise<DashboardListPayload> {
  return requestJson<DashboardListPayload>("/api/dashboards");
}

export async function createSharedDashboard(input: DashboardWriteInput): Promise<SharedDashboardDto> {
  const body = await requestJson<{ dashboard: SharedDashboardDto }>("/api/dashboards", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return body.dashboard;
}

export async function updateSharedDashboard(
  id: string,
  input: DashboardWriteInput,
): Promise<SharedDashboardDto> {
  const body = await requestJson<{ dashboard: SharedDashboardDto }>(`/api/dashboards/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
  return body.dashboard;
}

export async function deleteSharedDashboard(id: string): Promise<void> {
  await requestJson<{ deleted: boolean }>(`/api/dashboards/${id}`, { method: "DELETE" });
}

export async function fetchSharedDashboard(id: string): Promise<{ dashboard: SharedDashboardDto; canEdit: boolean }> {
  return requestJson<{ dashboard: SharedDashboardDto; canEdit: boolean }>(`/api/dashboards/${id}`);
}

/** Forks a viewable dashboard into a new one owned by the requester. */
export async function forkSharedDashboard(id: string): Promise<SharedDashboardDto> {
  const body = await requestJson<{ dashboard: SharedDashboardDto }>(`/api/dashboards/${id}/fork`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return body.dashboard;
}

export async function importDashboards(
  payload: unknown,
): Promise<DashboardImportResult> {
  return requestJson<DashboardImportResult>("/api/dashboards/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** Local view → the shared-dashboard schema's default widget layout (v2). */
export function savedViewToDashboardInput(
  name: string,
  view: SavedView,
  options?: { widgets?: SharedDashboardDto["widgets"]; dockerFilter?: string },
): DashboardWriteInput {
  return {
    name,
    widgets: options?.widgets ?? DEFAULT_WIDGETS,
    preferences: {
      historyWindow: view.historyWindow,
      density: view.density,
      tempUnit: view.tempUnit,
      refresh: view.refresh,
      dockerMetrics: view.dockerMetrics,
      showPerCore: view.showPerCore,
      dockerFilter: options?.dockerFilter ?? "",
      networkInterface: "",
    },
    access: DEFAULT_ACCESS,
  };
}

/** Default access for new dashboards (matches server default). */
export const DEFAULT_ACCESS = { mode: "shared-readonly" as const, editors: [], viewers: [] };

/** Applies a shared dashboard's preferences into local pref keys. */
export function dashboardToSavedView(dashboard: SharedDashboardDto): SavedView {
  return {
    refresh: dashboard.preferences.refresh,
    tempUnit: dashboard.preferences.tempUnit,
    density: dashboard.preferences.density,
    historyWindow: dashboard.preferences.historyWindow,
    showPerCore: dashboard.preferences.showPerCore,
    dockerMetrics: dashboard.preferences.dockerMetrics,
    overviewOrder: widgetsToOverviewOrder(dashboard.widgets),
  };
}

/** Export format: versioned, non-secret, importable. */
export function buildExportPayload(dashboards: SharedDashboardDto[]): unknown {
  return {
    exporter: "unraid-dashboard",
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    dashboards: dashboards.map((dashboard) => ({
      name: dashboard.name,
      widgets: dashboard.widgets,
      preferences: dashboard.preferences,
    })),
  };
}

/** Triggers a client-side download of the export JSON. */
export function downloadDashboardExport(dashboards: SharedDashboardDto[]): void {
  const blob = new Blob([JSON.stringify(buildExportPayload(dashboards), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `unraid-dashboards-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
