"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, RotateCcw, Save, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader, LoadingPanel } from "@/components/dashboard/page-primitives";
import { WidgetGrid, WIDGET_ICONS } from "@/components/dashboard/widget-registry";
import { usePoll } from "@/hooks/use-poll";
import { PAGE_INTERVAL_MS, usePrefs } from "@/lib/prefs";
import {
  DEFAULT_ACCESS,
  dashboardToSavedView,
  fetchSharedDashboard,
  updateSharedDashboard,
} from "@/lib/dashboards";
import { setBusyScope } from "@/lib/busy-guard";
import { WIDGET_IDS, WIDGET_LABELS, type WidgetEntry, type WidgetId, type WidgetSize } from "@/lib/widgets";
import { cn } from "@/lib/utils";
import type { OverviewPayload, SharedDashboardDto } from "@/lib/api-types";

/**
 * Shared dashboard view + deliberate edit mode (v0.7).
 *
 * - View: the stored widget layout renders read-only; every widget loads
 *   only its own data.
 * - Edit (owner only in proxy mode, everyone in trusted-LAN mode):
 *   reorder (move up/down — reliable on touch), show/hide, size selector
 *   over predefined spans only, preview, save, cancel. No freeform
 *   config; the server re-validates the whole layout on save.
 */

interface DashboardPayload {
  dashboard: SharedDashboardDto;
  identity: { mode: string; user: string | null };
  canEdit: boolean;
}

export default function SharedDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editMode, setEditMode] = useState(false);
  const [draft, setDraft] = useState<WidgetEntry[]>([]);
  const [draftAccess, setDraftAccess] = useState<SharedDashboardDto["access"]>({ mode: "shared-readonly", editors: [], viewers: [] });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { setPref } = usePrefs();

  useEffect(() => {
    let cancelled = false;
    fetchSharedDashboard(id)
      .then((body) => {
        if (!cancelled) setPayload({ dashboard: body.dashboard, identity: { mode: "disabled", user: null }, canEdit: body.canEdit });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Failed to load dashboard");
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // canEdit arrives with the payload; refetch once to pick it up cheaply.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/dashboards/${id}`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: DashboardPayload | null) => {
        if (!cancelled && body?.dashboard) setPayload(body);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [id]);

  const dashboard = payload?.dashboard ?? null;
  const canEdit = payload?.canEdit ?? false;
  const overview = usePoll<OverviewPayload>(
    dashboard ? `/api/overview?window=${dashboard.preferences.historyWindow}` : "/api/overview?window=15m",
    PAGE_INTERVAL_MS.overview,
  );

  // Apply the dashboard's preferences to the local session while viewing.
  useEffect(() => {
    if (!dashboard) return;
    const view = dashboardToSavedView(dashboard);
    setPref("density", view.density);
    setPref("tempUnit", view.tempUnit);
    setPref("dockerMetrics", view.dockerMetrics);
    setPref("showPerCore", view.showPerCore);
  }, [dashboard, setPref]);

  // Busy-guard: an open editor blocks deferred refreshes.
  useEffect(() => {
    setBusyScope("dashboard-editor", editMode);
    return () => setBusyScope("dashboard-editor", false);
  }, [editMode]);

  const preferences = useMemo(
    () =>
      dashboard
        ? {
            tempUnit: dashboard.preferences.tempUnit,
            dockerFilter: dashboard.preferences.dockerFilter,
            networkInterface: dashboard.preferences.networkInterface,
          }
        : { tempUnit: "C" as const, dockerFilter: "", networkInterface: "" },
    [dashboard],
  );

  const startEdit = () => {
    if (!dashboard) return;
    setDraft(dashboard.widgets.map((widget) => ({ ...widget })));
    setDraftAccess(dashboard.access);
    setSaveError(null);
    setEditMode(true);
  };

  const cancelEdit = () => setEditMode(false);

  const move = (index: number, direction: -1 | 1) => {
    setDraft((current) => {
      const next = [...current];
      const to = index + direction;
      if (to < 0 || to >= next.length) return current;
      [next[index], next[to]] = [next[to]!, next[index]!];
      return next;
    });
  };

  const setSize = (index: number, size: WidgetSize) => {
    setDraft((current) => current.map((widget, i) => (i === index ? { ...widget, size } : widget)));
  };

  const remove = (index: number) => {
    setDraft((current) => (current.length <= 1 ? current : current.filter((_, i) => i !== index)));
  };

  const add = (widgetId: WidgetId) => {
    setDraft((current) =>
      current.some((widget) => widget.id === widgetId) || current.length >= 12
        ? current
        : [...current, { id: widgetId, size: "sm" as WidgetSize }],
    );
  };

  const save = async () => {
    if (!dashboard) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateSharedDashboard(dashboard.id, {
        name: dashboard.name,
        widgets: draft,
        preferences: dashboard.preferences,
        access: draftAccess,
      });
      setPayload({ dashboard: updated, identity: payload?.identity ?? { mode: "disabled", user: null }, canEdit });
      setEditMode(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="space-y-3">
        <PageHeader title="Shared dashboard" description="This shared dashboard could not be loaded." />
        <Card>
          <CardContent className="flex items-center gap-3 pt-4 text-sm">
            <TriangleAlert className="size-4 text-destructive" aria-hidden="true" />
            <span>{loadError}</span>
          </CardContent>
        </Card>
        <Button asChild variant="outline" size="sm">
          <Link href="/"><ArrowLeft aria-hidden="true" /> Back to overview</Link>
        </Button>
      </div>
    );
  }

  if (!dashboard) {
    return <LoadingPanel rows={6} />;
  }

  const hiddenIds = WIDGET_IDS.filter((widgetId) => !draft.some((widget) => widget.id === widgetId));

  return (
    <div className="space-y-5">
      <PageHeader
        title={dashboard.name}
        description={`Shared dashboard · owner ${dashboard.owner} · ${editMode ? "edit mode" : "read-only view"}`}
        actions={
          canEdit && !editMode ? (
            <Button size="sm" variant="outline" onClick={startEdit}>
              <Pencil aria-hidden="true" /> Edit layout
            </Button>
          ) : undefined
        }
      />

      {overview.error && overview.data && (
        <p role="alert" className="text-xs text-warning">
          Refresh failed ({overview.error}) — showing last known data.
        </p>
      )}

      {editMode ? (
        <div className="space-y-4">
          {/* Access editor (v0.7.3): mode + editors list; server enforces. */}
          <div className="rounded-lg border bg-card/60 p-3">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Who can use this dashboard
            </p>
            <div role="group" aria-label="Access mode" className="mb-2 flex flex-wrap items-center gap-1">
              {(["private", "shared-readonly", "shared-editable"] as const).map((mode) => (
                <Button
                  key={mode}
                  size="sm"
                  variant={draftAccess.mode === mode ? "secondary" : "ghost"}
                  aria-pressed={draftAccess.mode === mode}
                  onClick={() => setDraftAccess({ ...DEFAULT_ACCESS, ...draftAccess, mode })}
                  className="h-7 px-2 text-[11px]"
                >
                  {mode === "private" ? "Private (me + viewers)" : mode === "shared-readonly" ? "Shared · view only" : "Shared · editable"}
                </Button>
              ))}
            </div>
            {draftAccess.mode !== "shared-readonly" && (
              <input
                value={draftAccess.mode === "private" ? draftAccess.viewers.join(", ") : draftAccess.editors.join(", ")}
                onChange={(event) => {
                  const list = event.target.value.split(",").map((entry) => entry.trim()).filter(Boolean).slice(0, 50);
                  setDraftAccess(
                    draftAccess.mode === "private"
                      ? { ...draftAccess, viewers: list }
                      : { ...draftAccess, editors: list.slice(0, 20) },
                  );
                }}
                placeholder={draftAccess.mode === "private" ? "Viewer identities, comma-separated (empty = only you)" : "Editor identities, comma-separated (empty = everyone)"}
                aria-label="Identity list"
                className="h-8 w-full max-w-md rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            )}
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Identities come from the sign-on provider. The server enforces these permissions —
              hiding buttons is never the enforcement.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/60 p-3">
            <p className="mr-auto text-xs text-muted-foreground">
              Reorder with the arrows, pick a size, hide widgets — then save. The server re-validates
              everything (registry ids, predefined sizes, ≤12 widgets).
            </p>
            <Button size="sm" variant="outline" onClick={cancelEdit} disabled={saving}>
              <X aria-hidden="true" /> Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving || draft.length === 0}>
              <Save aria-hidden="true" /> {saving ? "Saving…" : "Save layout"}
            </Button>
          </div>
          {saveError && <p role="alert" className="text-xs text-destructive">{saveError}</p>}

          <ol className="space-y-2">
            {draft.map((widget, index) => {
              const Icon = WIDGET_ICONS[widget.id];
              return (
                <li key={widget.id} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/60 p-2.5">
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden={true} />
                  <span className="min-w-0 flex-1 truncate text-sm">{WIDGET_LABELS[widget.id]}</span>
                  <div role="group" aria-label={`Size for ${WIDGET_LABELS[widget.id]}`} className="flex items-center gap-1">
                    {(["sm", "md", "lg"] as const).map((size) => (
                      <Button
                        key={size}
                        size="sm"
                        variant={widget.size === size ? "secondary" : "ghost"}
                        aria-pressed={widget.size === size}
                        onClick={() => setSize(index, size)}
                        className="h-7 px-2 text-[11px]"
                      >
                        {size}
                      </Button>
                    ))}
                  </div>
                  <Button size="sm" variant="ghost" aria-label={`Move ${WIDGET_LABELS[widget.id]} up`} disabled={index === 0} onClick={() => move(index, -1)} className="h-7 px-2">
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Move ${WIDGET_LABELS[widget.id]} down`} disabled={index === draft.length - 1} onClick={() => move(index, 1)} className="h-7 px-2">
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Hide ${WIDGET_LABELS[widget.id]}`} disabled={draft.length === 1} onClick={() => remove(index)} className="h-7 px-2">
                    <EyeOff aria-hidden="true" />
                  </Button>
                </li>
              );
            })}
          </ol>

          {hiddenIds.length > 0 && (
            <div className="rounded-lg border bg-card/60 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <Plus className="size-3.5" aria-hidden="true" /> Available widgets
              </p>
              <div className="flex flex-wrap gap-1.5">
                {hiddenIds.map((widgetId) => (
                  <Button key={widgetId} size="sm" variant="ghost" onClick={() => add(widgetId)} className="h-7 gap-1.5 px-2 text-xs">
                    <Eye aria-hidden="true" /> {WIDGET_LABELS[widgetId]}
                  </Button>
                ))}
              </div>
            </div>
          )}

          <section aria-label="Preview">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Preview</p>
            <WidgetGrid widgets={draft} overview={overview.data} preferences={preferences} />
          </section>
        </div>
      ) : (
        <WidgetGrid widgets={dashboard.widgets} overview={overview.data} preferences={preferences} />
      )}

      <p className="text-[11px] text-muted-foreground">
        {canEdit
          ? "You can edit this layout. Changes are validated server-side and audited."
          : "Read-only for your identity — only the owner can edit."}{" "}
        <Link href="/" className="underline underline-offset-2">Overview</Link>
      </p>
    </div>
  );
}
