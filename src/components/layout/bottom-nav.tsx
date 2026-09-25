"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Boxes, HardDrive, LayoutDashboard, MoreHorizontal, X } from "lucide-react";
import { NAV_ITEMS } from "@/lib/navigation";
import { Activity, BellRing, ClipboardList, Monitor, Network, ScrollText, Settings, Tv } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Phone bottom navigation: 4 primary destinations + "More" sheet with
 * the remaining pages. Desktop keeps the sidebar; this renders below
 * the md breakpoint only. Safe-area inset respected.
 */

const PRIMARY = [
  { title: "Overview", href: "/", icon: LayoutDashboard },
  { title: "Docker", href: "/docker", icon: Boxes },
  { title: "Storage", href: "/storage", icon: HardDrive },
  { title: "System", href: "/system", icon: Activity },
];

const SECONDARY_ICONS: Record<string, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  VMs: Monitor,
  Network: Network,
  Notifications: BellRing,
  Logs: ScrollText,
  Audit: ClipboardList,
  "NOC mode": Tv,
  Settings: Settings,
};

export function BottomNav() {
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  if (pathname === "/noc") return null; // standalone wallboard

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <>
      {moreOpen && (
        <button
          type="button"
          aria-label="Close navigation sheet"
          className="fixed inset-0 z-[60] bg-black/60"
          onClick={() => setMoreOpen(false)}
        />
      )}
      {moreOpen && (
        <div
          role="dialog"
          aria-label="More pages"
          className="fixed inset-x-0 bottom-0 z-[61] rounded-t-2xl border-t bg-card pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-2 shadow-2xl"
        >
          <div className="mx-auto flex max-w-md items-center justify-between px-4 pb-1">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">All pages</p>
            <button
              type="button"
              aria-label="Close"
              onClick={() => setMoreOpen(false)}
              className="rounded-full p-2 text-muted-foreground hover:bg-secondary"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <ul className="grid grid-cols-3 gap-1 px-3 pt-1">
            {NAV_ITEMS.filter((item) => !PRIMARY.some((primary) => primary.href === item.href)).map((item) => {
              const Icon = SECONDARY_ICONS[item.title] ?? MoreHorizontal;
              const active = isActive(item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={() => setMoreOpen(false)}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl px-2 py-2 text-xs",
                      active ? "bg-secondary font-medium text-foreground" : "text-muted-foreground hover:bg-secondary/60",
                    )}
                  >
                    <Icon className="size-5" aria-hidden={true} />
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-[62] border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        <ul className="grid grid-cols-5">
          {PRIMARY.map((item) => {
            const active = isActive(item.href);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex min-h-[56px] flex-col items-center justify-center gap-0.5 py-1.5 text-[11px]",
                    active ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  <item.icon className="size-5" aria-hidden={true} />
                  {item.title}
                </Link>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              aria-expanded={moreOpen}
              aria-label="More pages"
              onClick={() => setMoreOpen(true)}
              className="flex min-h-[56px] w-full flex-col items-center justify-center gap-0.5 py-1.5 text-[11px] text-muted-foreground"
            >
              <MoreHorizontal className="size-5" aria-hidden={true} />
              More
            </button>
          </li>
        </ul>
      </nav>
    </>
  );
}
