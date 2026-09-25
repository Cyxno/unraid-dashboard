import {
  Activity,
  Boxes,
  BellRing,
  HardDrive,
  LayoutDashboard,
  Monitor,
  Network,
  ScrollText,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Partially implemented — shows a badge in the sidebar. */
  partial?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { title: "Overview", href: "/", icon: LayoutDashboard },
  { title: "Docker", href: "/docker", icon: Boxes },
  { title: "Storage", href: "/storage", icon: HardDrive },
  { title: "VMs", href: "/vms", icon: Monitor, partial: true },
  { title: "Network", href: "/network", icon: Network },
  { title: "System", href: "/system", icon: Activity },
  { title: "Notifications", href: "/notifications", icon: BellRing },
  { title: "Logs", href: "/logs", icon: ScrollText },
  { title: "Settings", href: "/settings", icon: Settings },
];
