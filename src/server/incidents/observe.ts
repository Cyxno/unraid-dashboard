import type {
  ContainerHealthDetail,
  OverviewPayload,
  SourceHealth,
} from "@/lib/api-types";
import { recentTransitions } from "@/server/events/sampler";
import { getHelperStatus } from "@/server/update/helper-client";
import { peekInventoryLkg } from "@/server/docker/updates";
import { getAllSourceHealth, noteSourceAttempt } from "./source-health";
import { lastIncidentsSaveError, lastSuccessfulPersistAt } from "./store";

/**
 * Observation builder (v1.5.0 Fase 1 matrix → engine input).
 *
 * Assembles ONE normalized observation from surfaces the dashboard
 * ALREADY maintains: the overview payload (TTL-cached sections),
 * sampler transitions (in-memory), helper status (30s-cached here —
 * never a per-cycle helper poll), inventory LKG (read-only peek) and
 * the persistence bookkeeping. No new upstream requests beyond the
 * helper /status probe on its own 30s cache.
 */

export interface ObservedContainer {
  name: string;
  state: string;
  status: string | null;
  health: "healthy" | "unhealthy" | "starting" | null;
  autoStart: boolean;
  updateFailed: boolean;
  /** Helper inventory LKG (additive evidence; null when absent). */
  restartCount: number | null;
  healthDetail: ContainerHealthDetail | null;
}

export interface ObservedTransition {
  name: string;
  from: string;
  to: string;
  at: number;
}

export interface SectionProvenance {
  status: string;
  ageMs: number;
  reason: string | null;
}

export interface IncidentObservation {
  now: number;
  docker: {
    containers: ObservedContainer[];
    running: number;
    total: number;
  } | null;
  storage: {
    state: string | null;
    parityStatus: string | null;
    disks: Array<{ name: string; state: string | null; fsColor: string | null; temperatureC: number | null }>;
  } | null;
  notifications: { info: number; warning: number; alert: number } | null;
  vms: { total: number; running: number } | null;
  thermal: { packageC: number | null; package5mAvgC: number | null; peak1hC: number | null; hottestName: string | null } | null;
  temperatureSensors: { warningCount: number; criticalCount: number } | null;
  sustainedCpuPercent: number | null;
  memoryPercent: number | null;
  prometheus: { configured: boolean; status: "live" | "stale" | "unavailable" | null };
  helper: { configured: boolean; reachable: boolean | null; reason: string | null };
  persistence: { dataWritable: boolean | null; lastSaveError: string | null; lastPersistAt: string | null };
  transitions: ObservedTransition[];
  sources: SourceHealth[];
  topConsumers: Array<{ name: string; cpuPercent: number | null }> | null;
}

/* Helper status cache — bounds the /status probe to one per 30s. */
const globalCache = globalThis as unknown as {
  __incidentHelperStatus?: { at: number; value: Awaited<ReturnType<typeof getHelperStatus>> };
  __incidentUpdateFailures?: { at: number; failed: Set<string> };
};
const HELPER_STATUS_CACHE_MS = 30_000;
const UPDATE_FAILURE_CACHE_MS = 60_000;

async function cachedHelperStatus() {
  const cached = globalCache.__incidentHelperStatus;
  if (cached && Date.now() - cached.at < HELPER_STATUS_CACHE_MS) return cached.value;
  const startedAt = Date.now();
  const value = await getHelperStatus();
  // Re-note with measured latency for the source-performance ring (v1.6.0);
  // the earlier note in the cycle carries no latency.
  noteSourceAttempt("helper", {
    ok: !value.configured || value.reachable !== false,
    at: Date.now(),
    latencyMs: Date.now() - startedAt,
    detail: value.configured ? (value.reachable === false ? "unreachable" : "reachable") : "not configured",
    safeError: value.reachable === false ? (value.reason ?? "helper unreachable") : null,
  });
  globalCache.__incidentHelperStatus = { at: Date.now(), value };
  return value;
}

/** Containers whose LAST update attempt failed (update state — separate
 *  from health, but a failed update IS a warning incident, Fase 17). */
async function cachedUpdateFailures(): Promise<Set<string>> {
  const cached = globalCache.__incidentUpdateFailures;
  if (cached && Date.now() - cached.at < UPDATE_FAILURE_CACHE_MS) return cached.failed;
  const failed = new Set<string>();
  try {
    const { containerStatsBatch } = await import("@/server/update/history");
    const stats = await containerStatsBatch();
    for (const [target, entry] of stats) {
      if (entry.lastAttempt?.result === "failed") failed.add(target);
    }
  } catch {
    // History unreadable: no update-failure evidence this cycle.
  }
  globalCache.__incidentUpdateFailures = { at: Date.now(), failed };
  return failed;
}

/** Test hook. */
export function resetObservationCaches(): void {
  globalCache.__incidentHelperStatus = undefined;
  globalCache.__incidentUpdateFailures = undefined;
}


/** Parses docker status strings for restart evidence:
 *  "Restarting (1) 23 seconds ago" → { exitCode: 1, ageMs: 23000 }. */
export function parseRestartingStatus(status: string | null | undefined): { exitCode: number | null; ageMs: number | null } | null {
  if (!status) return null;
  const match = status.match(/Restarting\s*(?:\((\d+)\))?\s+(\d+)\s+(second|minute|hour|day)s?\s+ago/i);
  if (!match) return null;
  const multipliers: Record<string, number> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };
  const multiplier = multipliers[match[3]!];
  return {
    exitCode: match[1] != null ? Number(match[1]) : null,
    ageMs: multiplier != null ? Number(match[2]) * multiplier : null,
  };
}

function inventoryLookups(): Map<string, { restartCount: number | null; healthDetail: ContainerHealthDetail | null }> {
  const lookups = new Map<string, { restartCount: number | null; healthDetail: ContainerHealthDetail | null }>();
  const lkg = peekInventoryLkg();
  for (const fact of lkg?.containers ?? []) {
    // ContainerFacts is the raw helper shape; the fields we read are the
    // additive v1.5.0 ones (absent in older helpers → null evidence).
    const raw = fact as unknown as {
      name?: string;
      restartCount?: number | null;
      healthDetail?: {
        status?: string | null; failingStreak?: number | null; lastExitCode?: number | null;
        lastOutput?: string | null; lastCheckedAt?: string | null; lastSuccessAt?: string | null;
      } | null;
    };
    if (!raw?.name) continue;
    lookups.set(String(raw.name).replace(/^\//, ""), {
      restartCount: typeof raw.restartCount === "number" ? raw.restartCount : null,
      healthDetail: raw.healthDetail
        ? {
            status: raw.healthDetail.status ?? null,
            failingStreak: raw.healthDetail.failingStreak ?? null,
            lastExitCode: raw.healthDetail.lastExitCode ?? null,
            lastOutput: raw.healthDetail.lastOutput ?? null,
            lastCheckedAt: raw.healthDetail.lastCheckedAt ?? null,
            lastSuccessAt: raw.healthDetail.lastSuccessAt ?? null,
          }
        : null,
    });
  }
  return lookups;
}

/** Builds the observation from an overview payload the caller already
 *  fetched (NEVER fetches overview itself — keeps the cycle pure-ish and
 *  demand-driven on the existing cadence). */
export async function buildObservation(payload: OverviewPayload): Promise<IncidentObservation> {
  const now = Date.now();

  /* Record the Unraid-section provenance into the source registry so
     source health reflects per-section reality (Fase 2 wiring). */
  const sections: Record<string, { status: string; ageMs: number; reason?: string }> = {
    identity: payload.identity,
    metrics: payload.cpu,
    storage: payload.storage,
    docker: payload.docker,
    notifications: payload.notifications,
  };
  const entries = Object.entries(sections).map(([name, section]) => ({
    name,
    status: section.status,
    ageMs: section.ageMs,
    reason: section.reason ?? null,
  }));
  const usable = entries.filter((entry) => entry.status === "live" || entry.status === "stale" || entry.status === "demo");
  const demoActive = entries.every((entry) => entry.status === "demo");
  noteSourceAttempt("unraid-api", {
    ok: usable.length > 0,
    at: now,
    // Demo mode is a deliberate showcase (synthetic payloads), never an
    // outage of the source itself — recording it as "unavailable" made
    // demo installs show a false critical source incident.
    detail: demoActive ? "demo mode (synthetic data)" : `${usable.length}/${entries.length} sections usable`,
    safeError: usable.length === 0 ? (entries[0]?.reason ?? "unraid api unavailable") : null,
  });

  const helper = await cachedHelperStatus();
  noteSourceAttempt("helper", {
    ok: !helper.configured || helper.reachable !== false,
    at: now,
    detail: helper.configured ? (helper.reachable === false ? "unreachable" : "reachable") : "not configured",
    safeError: helper.reachable === false ? (helper.reason ?? "helper unreachable") : null,
  });

  const inventory = inventoryLookups();
  const updateFailures = await cachedUpdateFailures();

  const containers: ObservedContainer[] = (payload.docker.data?.containers ?? []).map((container) => {
    const extra = inventory.get(container.name) ?? { restartCount: null, healthDetail: null };
    return {
      name: container.name,
      state: container.state,
      status: container.status ?? null,
      health: container.health ?? null,
      autoStart: container.autoStart,
      updateFailed: updateFailures.has(container.name),
      restartCount: extra.restartCount ?? null,
      healthDetail: extra.healthDetail ?? null,
    };
  });

  const transitions: ObservedTransition[] = recentTransitions()
    .slice(0, 60)
    .map((transition) => ({
      name: transition.name,
      from: transition.from,
      to: transition.to,
      at: Date.parse(transition.at) || now,
    }))
    .filter((transition) => now - transition.at < 30 * 60_000);

  const saveError = lastIncidentsSaveError();

  return {
    now,
    docker: payload.docker.data
      ? {
          containers,
          running: payload.docker.data.running,
          total: payload.docker.data.total,
        }
      : null,
    storage: payload.storage.data
      ? {
          state: payload.storage.data.state,
          parityStatus: payload.storage.data.parityStatus ?? null,
          disks: (payload.storage.data.disks ?? []).map((disk) => ({
            name: disk.name,
            state: disk.state ?? null,
            fsColor: disk.fsColor ?? null,
            temperatureC: disk.temperatureC ?? null,
          })),
        }
      : null,
    notifications: payload.notifications.data
      ? {
          info: payload.notifications.data.unreadCounts.info,
          warning: payload.notifications.data.unreadCounts.warning,
          alert: payload.notifications.data.unreadCounts.alert,
        }
      : null,
    vms: null, // filled by the cycle (optional getVms probe, 30s TTL)
    thermal: payload.extras?.thermal
      ? {
          packageC: payload.extras.thermal.packageC,
          package5mAvgC: payload.extras.thermal.package5mAvgC,
          peak1hC: payload.extras.thermal.peak1hC,
          hottestName: payload.extras.thermal.hottestName,
        }
      : null,
    temperatureSensors: payload.temperature.data
      ? { warningCount: payload.temperature.data.warningCount, criticalCount: payload.temperature.data.criticalCount }
      : null,
    sustainedCpuPercent: payload.extras?.sustainedCpuPercent ?? null,
    memoryPercent: payload.memory.data?.percentTotal ?? null,
    prometheus: {
      configured: payload.extras?.prometheus.configured ?? false,
      status: payload.extras?.prometheus.status ?? null,
    },
    helper: {
      configured: helper.configured,
      reachable: helper.reachable,
      reason: helper.reachable === false ? (helper.reason ?? null) : null,
    },
    persistence: {
      dataWritable: null, // filled by the persistence self-check (Fase 25)
      lastSaveError: saveError?.message ?? null,
      lastPersistAt: lastSuccessfulPersistAt(),
    },
    transitions,
    sources: getAllSourceHealth(now),
    topConsumers:
      payload.extras?.topConsumers?.cpu?.slice(0, 3).map((entry) => ({
        name: entry.name,
        cpuPercent: entry.percent ?? null,
      })) ?? null,
  };
}

/** Used by rules for evidence age checks (re-exported for cohesion). */
