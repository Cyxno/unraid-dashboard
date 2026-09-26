import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024)),
  );
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : digits)} ${units[index]}`;
}

export function formatRate(bytesPerSec: number | null | undefined): string {
  if (bytesPerSec === null || bytesPerSec === undefined) return "—";
  return `${formatBytes(bytesPerSec)}/s`;
}

/** Renders electrical power in W (or kW above 1000 W). Input is watts. */
export function formatWatts(watts: number | null | undefined): string {
  if (watts === null || watts === undefined || !Number.isFinite(watts)) return "—";
  if (Math.abs(watts) >= 1000) return `${(watts / 1000).toFixed(2)} kW`;
  return `${watts.toFixed(0)} W`;
}

export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatPercent(
  value: number | null | undefined,
  digits: "auto" | number = "auto",
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const d =
    digits === "auto" ? (value >= 10 ? 0 : 1) : digits;
  return `${value.toFixed(d)}%`;
}

/** Renders a temperature in the user's preferred unit. Input is °C. */
export function formatTemp(
  celsius: number | null | undefined,
  unit: "C" | "F" = "C",
): string {
  if (celsius === null || celsius === undefined || !Number.isFinite(celsius)) return "—";
  if (unit === "F") return `${Math.round(celsius * 1.8 + 32)}°F`;
  return `${Math.round(celsius)}°C`;
}

/** "5m" ago style relative label from an age in milliseconds. */
export function formatAge(ageMs: number): string {
  if (ageMs < 5_000) return "just now";
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function formatDateTimeIso(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = Date.parse(iso);
  if (Number.isNaN(date)) return iso;
  return new Date(date).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Human label for Unraid array/disk state enums (STARTED -> Started). */
export function humanState(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replaceAll("_", " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
