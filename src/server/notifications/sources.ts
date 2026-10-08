import { checkForUpdate } from "@/server/actions/update-check";
import { enrichedOverview } from "@/server/docker/updates";
import { getOverview } from "@/server/unraid/service";
import { currentIncidentSnapshot, runIncidentCycle } from "@/server/incidents/cycle";
import { incidentToRawEvent } from "@/server/incidents/engine";
import type { RawEvent } from "./types";

/**
 * Event sources (v1.5.0): health-class conditions come EXCLUSIVELY from
 * the incident engine — one canonical vocabulary for the Overview,
 * Incident Center, notifications and agent API. This module triggers a
 * cycle (cheap: overview sections are TTL-cached) and maps ACTIVE
 * actionable incidents to RawEvents with stable fingerprints, so the
 * notification engine's dedupe/recovery logic works unchanged.
 *
 * Update availability stays deliberately OUT of the incident model
 * (update state is separate from health — v1.4.x semantics preserved).
 */

async function incidentEvents(): Promise<RawEvent[]> {
  try {
    // Ensure freshness even when no dashboard client is polling: the
    // cycle runs on cached sections, so this is at most one TTL-serving
    // overview evaluation per notification cycle (60s).
    const snapshot = currentIncidentSnapshot();
    const stale = snapshot.evaluatedAt == null || Date.now() - Date.parse(snapshot.evaluatedAt) > 30_000;
    if (stale) {
      await runIncidentCycle(await getOverview());
    }
    return currentIncidentSnapshot()
      .active.filter((incident) => incident.actionable)
      .map((incident) => incidentToRawEvent(incident, Date.now()));
  } catch {
    // Overview unavailable (e.g. before first Unraid answer): no events —
    // transient loading states never notify. The engine itself holds
    // existing incidents open during source outages (no false recovery).
    return [];
  }
}

async function dockerUpdateEvents(): Promise<RawEvent[]> {
  try {
    const enriched = await enrichedOverview();
    const containers = (enriched?.containers ?? []).filter(
      (entry) => entry.update_available,
    );
    if (containers.length === 0) return [];
    const names = containers.map((entry) => entry.name).sort();
    return [
      {
        fingerprint: `docker:updates:${names.join(",")}`,
        category: "docker-updates",
        severity: "info",
        title:
          containers.length === 1
            ? `Update available: ${names[0]}`
            : `${containers.length} container updates available`,
        body: names.join(", "),
        source: "docker",
        url: "/docker",
        occurredAt: Date.now(),
      },
    ];
  } catch {
    return [];
  }
}

async function beaconUpdateEvent(): Promise<RawEvent[]> {
  try {
    const status = await checkForUpdate();
    if (status.status === "available" && status.latestTag) {
      return [
        {
          fingerprint: `beacon:update:${status.latestTag}`,
          category: "beacon-updates",
          severity: "info",
          title: `Beacon v${status.latestTag.replace(/^v/, "")} is available`,
          body: "A newer release is on the registry. Update from Settings → Updates.",
          source: "beacon",
          url: "/settings",
          occurredAt: Date.now(),
        },
      ];
    }
  } catch {
    // Registry degraded is a service state, not a notification candidate —
    // it would fire on every offline poll and the engine's dedupe would
    // make it noisy for little value.
  }
  return [];
}

export async function collectEvents(): Promise<RawEvent[]> {
  const batches = await Promise.all([
    incidentEvents(),
    dockerUpdateEvents(),
    beaconUpdateEvent(),
  ]);
  return batches.flat();
}
