import {
  Activity,
  AlertTriangle,
  Bot,
  Boxes,
  BellRing,
  ClipboardList,
  HardDrive,
  LayoutDashboard,
  LineChart,
  Monitor,
  Network,
  ScrollText,
  Settings,
  ShieldCheck,
  Tv,
  type LucideIcon,
} from "lucide-react";

export type NavGroup = "overview" | "infrastructure" | "operations" | "observe" | "configure";

export interface NavItem {
  title: string;
  href: string;
  icon: LucideIcon;
  /** Sidebar section (v0.9.0 information architecture). */
  group: NavGroup;
  /** Partially implemented — shows a "partial" badge in the sidebar. */
  partial?: boolean;
  /** Meaningful capability badge (replaces the vague "partial"). */
  capability?: string;
}

export const NAV_GROUP_LABELS: Record<NavGroup, string> = {
  overview: "Overview",
  infrastructure: "Infrastructure",
  operations: "Operations",
  observe: "Observe",
  configure: "Configure",
};

export const NAV_ITEMS: NavItem[] = [
  { title: "Overview", href: "/", icon: LayoutDashboard, group: "overview" },
  { title: "Incidents", href: "/incidents", icon: AlertTriangle, group: "overview" },
  { title: "Insights", href: "/insights", icon: LineChart, group: "overview" },
  { title: "Docker", href: "/docker", icon: Boxes, group: "infrastructure" },
  { title: "Storage", href: "/storage", icon: HardDrive, group: "infrastructure" },
  { title: "VMs", href: "/vms", icon: Monitor, group: "infrastructure", capability: "power state" },
  { title: "Network", href: "/network", icon: Network, group: "infrastructure" },
  { title: "System", href: "/system", icon: Activity, group: "operations" },
  { title: "Automation", href: "/automation", icon: Bot, group: "operations" },
  { title: "Operations", href: "/operations", icon: ShieldCheck, group: "operations" },
  { title: "Notifications", href: "/notifications", icon: BellRing, group: "observe" },
  { title: "Logs", href: "/logs", icon: ScrollText, group: "observe" },
  { title: "Audit", href: "/audit", icon: ClipboardList, group: "observe" },
  { title: "NOC mode", href: "/noc", icon: Tv, group: "observe" },
  { title: "Settings", href: "/settings", icon: Settings, group: "configure" },
];
