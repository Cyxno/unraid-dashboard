"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpToLine,
  Bookmark,
  Check,
  Copy,
  Link2,
  Pencil,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { BUILT_IN_VIEWS, usePrefs, type SavedView } from "@/lib/prefs";
import {
  createSharedDashboard,
  deleteSharedDashboard,
  fetchDashboards,
  savedViewToDashboardInput,
  updateSharedDashboard,
} from "@/lib/dashboards";
import { useToast } from "@/components/layout/toast";
import { cn } from "@/lib/utils";
import type { SharedDashboardDto } from "@/lib/api-types";
import { widgetsToOverviewOrder } from "@/lib/widget-utils";

/**
 * Saved views menu: built-in presets, browser-local views, and
 * server-shared dashboards.
 *
 * Semantics (documented in README):
 * - Local views live only in this browser's localStorage.
 * - Shared dashboards persist on the server (/app/data/dashboards) and
 *   are reachable via /dashboard/<id> links.
 * - Nothing is uploaded automatically: a local view becomes shared only
 *   when the user clicks the upload action for it.
 */
export function ViewsMenu() {
  const { prefs, setPref } = usePrefs();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [activeView, setActiveView] = useState<string | null>(null);
  const [shared, setShared] = useState<SharedDashboardDto[] | null>(null);
  const [sharedBusy, setSharedBusy] = useState(false);
  const [renaming, setRenaming] = useState<{ kind: "local" | "shared"; key: string; value: string } | null>(null);
  const loadedOnce = useRef(false);

  const loadShared = useCallback(
    async (silent = false) => {
      setSharedBusy(true);
      try {
        const payload = await fetchDashboards();
        setShared(payload.dashboards);
      } catch (error) {
        if (!silent) {
          toast("connection", error instanceof Error ? `Shared dashboards unavailable: ${error.message}` : "Shared dashboards unavailable");
        }
      } finally {
        setSharedBusy(false);
      }
    },
    [toast],
  );

  // Load the shared list the first time the menu opens (not on page load).
  useEffect(() => {
    if (open && !loadedOnce.current) {
      loadedOnce.current = true;
      void loadShared(true);
    }
  }, [open, loadShared]);

  const applyView = (name: string, view: Partial<SavedView>) => {
    for (const [key, value] of Object.entries(view)) {
      setPref(key as keyof SavedView, value as never);
    }
    setActiveView(name);
    setOpen(false);
  };

  const applyShared = (dashboard: SharedDashboardDto) => {
    applyView(dashboard.name, {
      refresh: dashboard.preferences.refresh,
      tempUnit: dashboard.preferences.tempUnit,
      density: dashboard.preferences.density,
      historyWindow: dashboard.preferences.historyWindow,
      showPerCore: dashboard.preferences.showPerCore,
      dockerMetrics: dashboard.preferences.dockerMetrics,
      overviewOrder: widgetsToOverviewOrder(dashboard.widgets),
    });
  };

  const saveLocal = () => {
    const name = nameInput.trim().slice(0, 32);
    if (!name) return;
    const view = currentSavedView();
    setPref("savedViews", { ...prefs.savedViews, [name]: view });
    setNameInput("");
    setActiveView(name);
  };

  const currentSavedView = (): SavedView => ({
    refresh: prefs.refresh,
    tempUnit: prefs.tempUnit,
    density: prefs.density,
    historyWindow: prefs.historyWindow,
    showPerCore: prefs.showPerCore,
    dockerMetrics: prefs.dockerMetrics,
    overviewOrder: prefs.overviewOrder,
  });

  const deleteLocal = (name: string) => {
    const next = { ...prefs.savedViews };
    delete next[name];
    setPref("savedViews", next);
    if (activeView === name) setActiveView(null);
  };

  /** Explicit migration of one local view to the server. Never automatic. */
  const uploadLocal = async (name: string) => {
    const view = prefs.savedViews[name];
    if (!view) return;
    setSharedBusy(true);
    try {
      await createSharedDashboard(savedViewToDashboardInput(name, view));
      toast("success", `Uploaded "${name}" as a shared dashboard`);
      await loadShared(true);
    } catch (error) {
      toast("connection", error instanceof Error ? error.message : "Upload failed");
    } finally {
      setSharedBusy(false);
    }
  };

  const saveShared = async () => {
    const name = nameInput.trim().slice(0, 64);
    if (!name) return;
    setSharedBusy(true);
    try {
      await createSharedDashboard(savedViewToDashboardInput(name, currentSavedView()));
      setNameInput("");
      toast("success", `Saved shared dashboard "${name}"`);
      await loadShared(true);
    } catch (error) {
      toast("connection", error instanceof Error ? error.message : "Save failed");
    } finally {
      setSharedBusy(false);
    }
  };

  const duplicateSharedToLocal = (dashboard: SharedDashboardDto) => {
    const name = `${dashboard.name} (copy)`.slice(0, 32);
    setPref("savedViews", {
      ...prefs.savedViews,
      [name]: {
        refresh: dashboard.preferences.refresh,
        tempUnit: dashboard.preferences.tempUnit,
        density: dashboard.preferences.density,
        historyWindow: dashboard.preferences.historyWindow,
        showPerCore: dashboard.preferences.showPerCore,
        dockerMetrics: dashboard.preferences.dockerMetrics,
        overviewOrder: widgetsToOverviewOrder(dashboard.widgets),
      },
    });
    toast("success", `Copied "${dashboard.name}" to local views`);
  };

  const renameShared = async (dashboard: SharedDashboardDto, nextName: string) => {
    setSharedBusy(true);
    try {
      await updateSharedDashboard(dashboard.id, {
        name: nextName,
        widgets: dashboard.widgets,
        preferences: dashboard.preferences,
      });
      await loadShared(true);
    } catch (error) {
      toast("connection", error instanceof Error ? error.message : "Rename failed");
    } finally {
      setSharedBusy(false);
    }
  };

  const removeShared = async (dashboard: SharedDashboardDto) => {
    setSharedBusy(true);
    try {
      await deleteSharedDashboard(dashboard.id);
      await loadShared(true);
      toast("success", `Deleted shared dashboard "${dashboard.name}"`);
    } catch (error) {
      toast("connection", error instanceof Error ? error.message : "Delete failed");
    } finally {
      setSharedBusy(false);
    }
  };

  const copyShareLink = async (dashboard: SharedDashboardDto) => {
    const url = `${window.location.origin}/dashboard/${dashboard.id}`;
    try {
      await navigator.clipboard.writeText(url);
      toast("success", "Share link copied");
    } catch {
      toast("connection", url);
    }
  };

  const commitRename = () => {
    if (!renaming) return;
    const nextName = renaming.value.trim().slice(0, renaming.kind === "local" ? 32 : 64);
    if (nextName) {
      if (renaming.kind === "local") {
        const view = prefs.savedViews[renaming.key];
        if (view) {
          const next = { ...prefs.savedViews };
          delete next[renaming.key];
          next[nextName] = view;
          setPref("savedViews", next);
        }
      } else {
        const dashboard = shared?.find((entry) => entry.id === renaming.key);
        if (dashboard) void renameShared(dashboard, nextName);
      }
    }
    setRenaming(null);
  };

  return (
    <div className="relative">
      <Button
        size="sm"
        variant="ghost"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="h-7 gap-1.5 px-2 text-xs"
      >
        <Bookmark className="size-3.5" aria-hidden="true" />
        {activeView ?? "Views"}
      </Button>
      {open && (
        <div
          role="menu"
          aria-label="Saved views"
          className="absolute right-0 top-9 z-50 max-h-[70vh] w-72 overflow-y-auto rounded-lg border bg-card p-2 shadow-xl"
        >
          <p className="px-2 pb-1 pt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            Presets
          </p>
          {Object.entries(BUILT_IN_VIEWS).map(([name, build]) => (
            <button
              key={name}
              type="button"
              role="menuitem"
              onClick={() => applyView(name, build())}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/60"
            >
              {activeView === name && <Check className="size-3.5" aria-hidden="true" />}
              <span className={cn(activeView !== name && "pl-5")}>{name}</span>
            </button>
          ))}

          <p className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            Local — this browser
          </p>
          {Object.keys(prefs.savedViews).length === 0 && (
            <p className="px-2 pb-1 text-xs text-muted-foreground">No local views yet.</p>
          )}
          {Object.entries(prefs.savedViews).map(([name, view]) =>
            renaming?.kind === "local" && renaming.key === name ? (
              <div key={name} className="flex items-center gap-1 px-2 py-1">
                <input
                  autoFocus
                  value={renaming.value}
                  onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") commitRename();
                    if (event.key === "Escape") setRenaming(null);
                  }}
                  aria-label="Rename local view"
                  className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Button size="sm" variant="ghost" className="h-7 px-2" onClick={commitRename}>
                  <Check className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <div key={name} className="flex items-center">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => applyView(name, view)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/60"
                >
                  {activeView === name ? (
                    <Check className="size-3.5 shrink-0" aria-hidden="true" />
                  ) : (
                    <span className="w-3.5 shrink-0" />
                  )}
                  <span className="truncate">{name}</span>
                </button>
                <button
                  type="button"
                  title="Save to server (shared)"
                  aria-label={`Upload view ${name} to the server`}
                  disabled={sharedBusy}
                  onClick={() => void uploadLocal(name)}
                  className="rounded p-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                >
                  <ArrowUpToLine className="size-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Rename view ${name}`}
                  onClick={() => setRenaming({ kind: "local", key: name, value: name })}
                  className="rounded p-1.5 text-muted-foreground hover:bg-secondary/60"
                >
                  <Pencil className="size-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  aria-label={`Delete view ${name}`}
                  onClick={() => deleteLocal(name)}
                  className="rounded p-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              </div>
            ),
          )}

          <p className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Server className="size-3" aria-hidden="true" /> Shared — server
          </p>
          {shared === null ? (
            <p className="px-2 pb-1 text-xs text-muted-foreground">
              {sharedBusy ? "Loading…" : "No shared dashboards loaded."}
            </p>
          ) : shared.length === 0 ? (
            <p className="px-2 pb-1 text-xs text-muted-foreground">No shared dashboards yet.</p>
          ) : (
            shared.map((dashboard) =>
              renaming?.kind === "shared" && renaming.key === dashboard.id ? (
                <div key={dashboard.id} className="flex items-center gap-1 px-2 py-1">
                  <input
                    autoFocus
                    value={renaming.value}
                    onChange={(event) => setRenaming({ ...renaming, value: event.target.value })}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename();
                      if (event.key === "Escape") setRenaming(null);
                    }}
                    aria-label="Rename shared dashboard"
                    className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={commitRename}>
                    <Check className="size-3.5" aria-hidden="true" />
                  </Button>
                </div>
              ) : (
                <div key={dashboard.id} className="flex items-center">
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => applyShared(dashboard)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-secondary/60"
                  >
                    <Server className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="truncate" title={`owner: ${dashboard.owner}`}>
                      {dashboard.name}
                    </span>
                  </button>
                  <button
                    type="button"
                    title="Copy shareable link"
                    aria-label={`Copy link to ${dashboard.name}`}
                    onClick={() => void copyShareLink(dashboard)}
                    className="rounded p-1.5 text-muted-foreground hover:bg-secondary/60"
                  >
                    <Link2 className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    title="Copy to local views"
                    aria-label={`Copy ${dashboard.name} to local views`}
                    onClick={() => duplicateSharedToLocal(dashboard)}
                    className="rounded p-1.5 text-muted-foreground hover:bg-secondary/60"
                  >
                    <Copy className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Rename shared dashboard ${dashboard.name}`}
                    onClick={() => setRenaming({ kind: "shared", key: dashboard.id, value: dashboard.name })}
                    className="rounded p-1.5 text-muted-foreground hover:bg-secondary/60"
                  >
                    <Pencil className="size-3.5" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete shared dashboard ${dashboard.name}`}
                    disabled={sharedBusy}
                    onClick={() => void removeShared(dashboard)}
                    className="rounded p-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                </div>
              ),
            )
          )}

          <div className="mt-1.5 flex items-center gap-1 border-t pt-2">
            <input
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveShared();
              }}
              placeholder="Save current as…"
              aria-label="New view name"
              className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={saveLocal}
              disabled={!nameInput.trim()}
              aria-label="Save current preferences as a local view"
              className="h-7 px-2"
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!nameInput.trim() || sharedBusy}
              onClick={() => void saveShared()}
              aria-label="Save current preferences as a shared dashboard on the server"
              className="h-7 px-2"
            >
              <Server className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
          <p className="px-2 pt-1 text-[10px] leading-snug text-muted-foreground">
            + saves locally · <Server className="inline size-2.5" aria-hidden="true" /> saves to the server (shareable link).
            Local views are never uploaded automatically.
          </p>
        </div>
      )}
    </div>
  );
}
