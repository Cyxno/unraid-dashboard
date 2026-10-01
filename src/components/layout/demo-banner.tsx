"use client";

import { useState } from "react";
import { TriangleAlert, X } from "lucide-react";
import type { OverviewPayload } from "@/lib/api-types";
import type { PollResult } from "@/hooks/use-poll";

/**
 * Explains WHY the dashboard is showing built-in demo data instead of
 * leaving a healthy-looking demo dashboard to speak for itself. The two
 * real-world cases for a fresh install:
 * - the API key was rejected (401/403) → point at UNRAID_API_KEY
 * - the API is unreachable → point at UNRAID_URL / network
 * The reason travels in the section payloads (demo substitution preserves
 * it server-side); this surfaces it. Dismissible for the session — it
 * returns on the next page load until the connection actually works.
 */

const DEMO_SECTIONS = [
  "identity",
  "cpu",
  "memory",
  "storage",
  "docker",
  "network",
  "notifications",
] as const;

function demoExplanation(payload: OverviewPayload | null): string | null {
  if (!payload) return null;
  const sections: { status?: string; reason?: string | null }[] = [
    payload.identity,
    payload.cpu,
    payload.memory,
    payload.storage,
    payload.docker,
    payload.network,
    payload.notifications,
  ];
  const demo = sections.find((section) => section?.status === "demo");
  if (!demo) return null;
  const reason = demo.reason ?? "the Unraid API has not responded yet";
  if (/401|403|unauthorized|forbidden/i.test(reason)) {
    return `The Unraid API rejected the configured API key (${reason}) — Beacon is showing built-in demo data until the connection works. Check UNRAID_API_KEY on the container; Settings → Server connection shows the current state.`;
  }
  return `The Unraid API is unreachable (${reason}) — Beacon is showing built-in demo data until the connection works. Check UNRAID_URL and network access; Settings → Server connection shows the current state.`;
}

export function DemoBanner({ overview }: { overview: PollResult<OverviewPayload> }) {
  const [dismissed, setDismissed] = useState(false);
  const explanation = demoExplanation(overview.data);
  if (dismissed || !explanation) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-warning/30 bg-warning/15 px-4 py-1.5 text-xs font-medium text-warning"
    >
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden={true} />
      <span className="min-w-0 truncate" title={explanation}>
        {explanation}
      </span>
      <button
        type="button"
        aria-label="Dismiss demo notice"
        className="shrink-0 rounded p-0.5 hover:bg-warning/20"
        onClick={() => setDismissed(true)}
      >
        <X className="size-3.5" aria-hidden={true} />
      </button>
    </div>
  );
}
