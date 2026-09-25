"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, Server } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_ITEMS } from "@/lib/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";


interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function Sidebar({ mobileOpen, onMobileClose, collapsed, onToggleCollapsed }: SidebarProps) {
  const pathname = usePathname();

  return (
    <>
      {mobileOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={onMobileClose}
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
        />
      )}
      <aside
        data-collapsed={collapsed}
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r bg-card transition-[width,transform] duration-200",
          collapsed ? "md:w-14" : "md:w-56",
          "w-60",
          mobileOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        <div
          className={cn(
            "flex h-14 shrink-0 items-center gap-2.5 border-b px-3",
            collapsed && "md:justify-center md:px-0",
          )}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/15 text-primary">
            <Server className="size-4" aria-hidden="true" />
          </span>
          <div className={cn("min-w-0 leading-tight", collapsed && "md:hidden")}>
            <p className="truncate text-sm font-semibold">Unraid Dashboard</p>
            <p className="truncate text-xs text-muted-foreground">Server Console</p>
          </div>
        </div>

        <nav
          aria-label="Main navigation"
          className="flex-1 space-y-0.5 overflow-y-auto p-2"
        >
          {NAV_ITEMS.map((item) => {
            const active =
              item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onMobileClose}
                title={collapsed ? item.title : undefined}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-secondary font-medium text-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                  collapsed && "md:justify-center md:px-0",
                )}
              >
                <item.icon className="size-4 shrink-0" aria-hidden="true" />
                <span className={cn("flex-1", collapsed && "md:hidden")}>
                  {item.title}
                </span>
                {item.partial && (
                  <Badge
                    variant="muted"
                    className={cn("px-1.5 text-[10px]", collapsed && "md:hidden")}
                  >
                    partial
                  </Badge>
                )}
              </Link>
            );
          })}
        </nav>

        <div
          className={cn(
            "flex shrink-0 items-center border-t p-2",
            collapsed ? "md:justify-center" : "justify-between px-3",
          )}
        >
          <span
            className={cn(
              "truncate text-[11px] text-muted-foreground",
              collapsed && "md:hidden",
            )}
          >
            BFF proxy · key stays server-side
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-pressed={collapsed}
            onClick={onToggleCollapsed}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" />
            ) : (
              <PanelLeftClose aria-hidden="true" />
            )}
          </Button>
        </div>
      </aside>
    </>
  );
}
