"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import { Boxes, Monitor, Search, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Lightweight command palette (Ctrl/Cmd+K): page navigation, container
 * search and NOC toggle. Read-only — no write actions are exposed here.
 */

interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  group: "Pages" | "Containers" | "Actions";
  run: (router: ReturnType<typeof useRouter>) => void;
}

const PAGES: PaletteItem[] = [
  { id: "nav-overview", label: "Overview", group: "Pages", run: (r) => r.push("/") },
  { id: "nav-docker", label: "Docker", group: "Pages", run: (r) => r.push("/docker") },
  { id: "nav-storage", label: "Storage", group: "Pages", run: (r) => r.push("/storage") },
  { id: "nav-network", label: "Network", group: "Pages", run: (r) => r.push("/network") },
  { id: "nav-system", label: "System", group: "Pages", run: (r) => r.push("/system") },
  { id: "nav-vms", label: "VMs", group: "Pages", run: (r) => r.push("/vms") },
  { id: "nav-notifications", label: "Notifications", group: "Pages", run: (r) => r.push("/notifications") },
  { id: "nav-logs", label: "Logs", group: "Pages", run: (r) => r.push("/logs") },
  { id: "nav-audit", label: "Audit log", group: "Pages", run: (r) => r.push("/audit") },
  { id: "nav-settings", label: "Settings", group: "Pages", hint: "preferences, security, about", run: (r) => r.push("/settings") },
  {
    id: "action-noc",
    label: "Toggle NOC mode",
    group: "Actions",
    hint: "fullscreen wallboard",
    run: (r) => r.push("/noc"),
  },
];

interface ContainerRow {
  name: string;
  state: string;
  image: string;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [containers, setContainers] = useState<ContainerRow[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Global hotkey.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => {
          if (!value) {
            setQuery("");
            setActive(0);
          }
          return !value;
        });
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Load container index once per open (cached data is fine — 60 rows).
  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    fetch("/api/docker", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        const list: ContainerRow[] = (data?.data?.containers ?? []).map(
          (container: { name: string; state: string; image: string }) => ({
            name: container.name,
            state: container.state,
            image: container.image,
          }),
        );
        setContainers(list);
      })
      .catch(() => {});
  }, [open]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const containerItems: PaletteItem[] = containers.map((container) => ({
      id: `container-${container.name}`,
      label: container.name,
      hint: `${container.state.toLowerCase()} · ${container.image.split("/").at(-1) ?? ""}`,
      group: "Containers",
      run: (r) => r.push(`/docker/${encodeURIComponent(container.name)}`),
    }));
    const all = [...PAGES, ...containerItems];
    if (!q) return all.slice(0, 20);
    return all
      .filter((item) => item.label.toLowerCase().includes(q) || item.hint?.toLowerCase().includes(q))
      .slice(0, 20);
  }, [query, containers]);

  // Keyboard navigation.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((value) => Math.min(items.length - 1, value + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((value) => Math.max(0, value - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[active];
      if (item) {
        setOpen(false);
        item.run(router);
      }
    }
  };

  if (!open) return null;

  let lastGroup = "";

  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-start justify-center pt-[15vh]">
      <button
        type="button"
        aria-label="Close command palette"
        onClick={() => setOpen(false)}
        className="absolute inset-0 bg-black/60"
        tabIndex={-1}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-lg rounded-lg border bg-card shadow-xl"
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search pages and containers…"
            aria-label="Search pages and containers"
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <kbd className="rounded border px-1.5 text-[10px] text-muted-foreground">esc</kbd>
        </div>
        <ul ref={listRef} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</li>
          )}
          {items.map((item, index) => {
            const showGroup = item.group !== lastGroup;
            lastGroup = item.group;
            return (
              <li key={item.id} role="option" aria-selected={index === active}>
                {showGroup && (
                  <p className="px-3 pb-1 pt-2 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {item.group}
                  </p>
                )}
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                    index === active ? "bg-secondary" : "hover:bg-secondary/50",
                  )}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => {
                    setOpen(false);
                    item.run(router);
                  }}
                >
                  {item.group === "Containers" ? (
                    <Boxes className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  ) : item.group === "Actions" ? (
                    <Monitor className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <Settings className="size-3.5 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint && <span className="shrink-0 text-xs text-muted-foreground">{item.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
