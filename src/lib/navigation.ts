import {
  Boxes,
  Cpu,
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
  /** Placeholder pages are intentionally disabled until implemented. */
  placeholder: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { title: "Overview", href: "/", icon: LayoutDashboard, placeholder: false },
  { title: "Docker", href: "/docker", icon: Boxes, placeholder: true },
  { title: "Storage", href: "/storage", icon: HardDrive, placeholder: true },
  { title: "VMs", href: "/vms", icon: Monitor, placeholder: true },
  { title: "Network", href: "/network", icon: Network, placeholder: true },
  { title: "Logs", href: "/logs", icon: ScrollText, placeholder: true },
  { title: "Settings", href: "/settings", icon: Settings, placeholder: true },
];

export const PLACEHOLDER_ICON = Cpu;
