"use client";

import { useState } from "react";
import { Bookmark, Check, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BUILT_IN_VIEWS, usePrefs, type SavedView } from "@/lib/prefs";
import { cn } from "@/lib/utils";

/**
 * Saved views menu: built-in presets plus user-saved snapshots of the
 * display prefs. Views live in localStorage — nothing sensitive.
 */
export function ViewsMenu() {
  const { prefs, setPref } = usePrefs();
  const [open, setOpen] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [activeView, setActiveView] = useState<string | null>(null);

  const applyView = (name: string, view: Partial<SavedView>) => {
    for (const [key, value] of Object.entries(view)) {
      setPref(key as keyof SavedView, value as never);
    }
    setActiveView(name);
    setOpen(false);
  };

  const saveCurrent = () => {
    const name = nameInput.trim().slice(0, 32);
    if (!name) return;
    const view: SavedView = {
      refresh: prefs.refresh,
      tempUnit: prefs.tempUnit,
      density: prefs.density,
      historyWindow: prefs.historyWindow,
      showPerCore: prefs.showPerCore,
      dockerMetrics: prefs.dockerMetrics,
      overviewOrder: prefs.overviewOrder,
    };
    setPref("savedViews", { ...prefs.savedViews, [name]: view });
    setNameInput("");
    setActiveView(name);
  };

  const deleteView = (name: string) => {
    const next = { ...prefs.savedViews };
    delete next[name];
    setPref("savedViews", next);
    if (activeView === name) setActiveView(null);
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
          className="absolute right-0 top-9 z-50 w-64 rounded-lg border bg-card p-2 shadow-xl"
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
          {Object.keys(prefs.savedViews).length > 0 && (
            <p className="px-2 pb-1 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
              Saved views
            </p>
          )}
          {Object.entries(prefs.savedViews).map(([name, view]) => (
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
                aria-label={`Delete view ${name}`}
                onClick={() => deleteView(name)}
                className="rounded p-1.5 text-muted-foreground hover:bg-secondary/60 hover:text-destructive"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
          <div className="mt-1.5 flex items-center gap-1 border-t pt-2">
            <input
              value={nameInput}
              onChange={(event) => setNameInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveCurrent();
              }}
              placeholder="Save current as…"
              aria-label="New view name"
              className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={saveCurrent}
              disabled={!nameInput.trim()}
              aria-label="Save current preferences as a view"
              className="h-7 px-2"
            >
              <Plus className="size-3.5" aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
