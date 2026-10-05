import { getHelperStatus } from "@/server/update/helper-client";
import { checkForUpdate } from "@/server/actions/update-check";
import { getOverview } from "@/server/unraid/service";
import { enrichedOverview } from "@/server/docker/updates";
import type { RawEvent } from "./types";

/**
 * Event sources: derive raw notification events from Beacon's EXISTING
 * state surfaces (overview health semantics, the Unraid-reported
 * `updateAvailable` flag, the cached registry check, helper status).
 * Every event carries a STABLE fingerprint so the engine dedupes by
 * identity, not by poll cycle. Sources never trigger registry sweeps.
 */


async function healthEvents(): Promise<RawEvent[]> {
  const events: RawEvent[] = [];
  try {
    const overview = await getOverview();
    if (overview.docker?.status === "live" && overview.docker.data) {
      for (const container of overview.docker.data.containers) {
        if (container.health === "unhealthy") {
          events.push({
            fingerprint: `docker:container:${container.name}:unhealthy`,
            category: "docker-health",
            severity: "critical",
            title: `Container unhealthy: ${container.name}`,
            body: container.status || "The container's health check reports unhealthy.",
            source: "docker",
            url: `/docker/${encodeURIComponent(container.name)}`,
            occurredAt: Date.now(),
          });
        }
      }
    }
    if (overview.storage?.status === "live" && overview.storage.data) {
      const storage = overview.storage.data;
      if (storage.state && storage.state !== "STARTED") {
        events.push({
          fingerprint: `storage:array:${storage.state}`,
          category: "storage",
          severity: "critical",
          title: `Array ${storage.state.replaceAll("_", " ").toLowerCase()}`,
          body: "The Unraid array is not in its nominal started state.",
          source: "storage",
          url: "/storage",
          occurredAt: Date.now(),
        });
      }
      for (const disk of storage.disks ?? []) {
        const critical =
          disk.fsColor === "RED" || disk.fsColor === "RED_BALL" ||
          (disk.state && !["DISK_OK", "DISK_NP", "DISK_DSBL_NP"].includes(disk.state));
        const warning = !critical && disk.temperatureC != null && disk.temperatureC >= 45;
        if (critical || warning) {
          events.push({
            fingerprint: `storage:disk:${disk.name}:${critical ? "critical" : "warning"}`,
            category: "storage",
            severity: critical ? "critical" : "warning",
            title: `Disk ${disk.name} ${critical ? "critical" : "warning"}`,
            body: critical
              ? `State ${disk.state ?? "unknown"}${disk.fsColor ? ` (${disk.fsColor})` : ""}.`
              : `Temperature ${disk.temperatureC}°C.`,
            source: "storage",
            url: "/storage",
            occurredAt: Date.now(),
          });
        }
      }
    }
    // Note: autostart+stopped containers are deliberately NOT events —
    // a stopped container is a state, not an incident (v1.1.5 semantics).
  } catch {
    // Overview unavailable (e.g. before first Unraid answer): no events —
    // transient loading states never notify.
  }
  return events;
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

async function serviceEvents(): Promise<RawEvent[]> {
  try {
    const helper = await getHelperStatus();
    // Only an OPERATOR-CONFIGURED helper that drops offline is a service
    // warning; "not configured" is a valid steady state.
    if (helper.configured && helper.reachable === false) {
      return [
        {
          fingerprint: "services:helper:unreachable",
          category: "services",
          severity: "warning",
          title: "Update helper unreachable",
          body: helper.reason ?? "The configured update helper is not responding.",
          source: "services",
          url: "/settings",
          occurredAt: Date.now(),
        },
      ];
    }
  } catch {
    // helper status failing is itself the condition above; never throw.
  }
  return [];
}

export async function collectEvents(): Promise<RawEvent[]> {
  const batches = await Promise.all([
    healthEvents(),
    dockerUpdateEvents(),
    beaconUpdateEvent(),
    serviceEvents(),
  ]);
  return batches.flat();
}
