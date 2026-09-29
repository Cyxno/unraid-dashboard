"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_GROUP_LABELS, NAV_ITEMS, type NavGroup } from "@/lib/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { BeaconMark } from "@/components/brand/logo";

interface SidebarProps {
  mobileOpen: boolean;
  onMobileClose: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

const GROUP_ORDER: NavGroup[] = ["overview", "infrastructure", "operations", "observe", "configure"];

export function Sidebar({ mobileOpen, onMobileClose, collapsed, onToggleCollapsed }: SidebarProps) {
  const pathname = usePathname();

  const grouped = GROUP_ORDER.map((group) => ({
    group,
    items: NAV_ITEMS.filter((item) => item.group === group),
  })).filter((entry) => entry.items.length > 0);

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
        style={{ paddingLeft: "env(safe-area-inset-left)" }}
      >
        {/* Product identity */}
        <div
          className={cn(
            "flex h-14 shrink-0 items-center gap-2.5 border-b px-3",
            collapsed && "md:justify-center md:px-0",
          )}
        >
          <BeaconMark className="size-8 rounded-lg" />
          <div className={cn("min-w-0 leading-tight", collapsed && "md:hidden")}>
            <p className="truncate text-sm font-semibold tracking-tight">Beacon</p>
            <p className="truncate text-[11px] text-muted-foreground">Unraid server console</p>
          </div>
        </div>

        <nav
          aria-label="Main navigation"
          className="flex-1 space-y-1 overflow-y-auto p-2"
        >
          {grouped.map(({ group, items }, groupIndex) => (
            <div key={group} className={cn(groupIndex > 0 && "mt-2 border-t pt-2 border-border/50")}>
              <p
                className={cn(
                  "px-2.5 pb-1 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70",
                  collapsed && "md:hidden",
                )}
              >
                {NAV_GROUP_LABELS[group]}
              </p>
              {items.map((item) => {
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
                      "relative flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "bg-primary/10 font-medium text-foreground before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-primary"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                      collapsed && "md:justify-center md:px-0",
                    )}
                  >
                    <item.icon
                      className={cn("size-4 shrink-0", active && "text-primary")}
                      aria-hidden="true"
                    />
                    <span className={cn("flex-1", collapsed && "md:hidden")}>
                      {item.title}
                    </span>
                    {item.capability && (
                      <Badge
                        variant="muted"
                        className={cn("px-1.5 text-[10px]", collapsed && "md:hidden")}
                      >
                        {item.capability}
                      </Badge>
                    )}
                    {item.partial && !item.capability && (
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
            </div>
          ))}
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
