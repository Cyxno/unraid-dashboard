"use client";

import { Button } from "@/components/ui/button";
import { type HistoryWindowPref } from "@/lib/prefs";

const WINDOW_LABEL: Record<HistoryWindowPref, string> = {
  "5m": "5m",
  "15m": "15m",
  "1h": "1h",
  "6h": "6h",
  "24h": "24h",
  "7d": "7d",
};

export const WINDOW_OPTIONS = Object.keys(WINDOW_LABEL) as HistoryWindowPref[];

export function windowLabel(window: HistoryWindowPref): string {
  return WINDOW_LABEL[window];
}

export function WindowPicker({
  value,
  onChange,
  options = WINDOW_OPTIONS,
}: {
  value: HistoryWindowPref;
  onChange: (window: HistoryWindowPref) => void;
  options?: HistoryWindowPref[];
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label="History time window"
    >
      {options.map((option) => (
        <Button
          key={option}
          size="sm"
          variant={value === option ? "secondary" : "ghost"}
          aria-pressed={value === option}
          onClick={() => onChange(option)}
          className="h-7 px-2.5 text-xs"
        >
          {WINDOW_LABEL[option]}
        </Button>
      ))}
    </div>
  );
}
