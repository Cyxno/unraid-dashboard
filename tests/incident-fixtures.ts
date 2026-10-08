import type { IncidentObservation, ObservedContainer } from "../src/server/incidents/observe";
import type { IncidentsState } from "../src/server/incidents/store";
import type { SourceHealth } from "../src/lib/api-types";

/**
 * Production-like incident fixtures (v1.5.0 Fase 31).
 *
 * One builder per scenario from the release checklist; the engine and
 * rules are pure over IncidentObservation, so every scenario is a plain
 * object — no mocks, no network, no clocks beyond the fixed NOW.
 */

export const NOW = 1_791_500_000_000; // fixed epoch (ms)

const iso = (at: number) => new Date(at).toISOString();

export function sourceHealth(
  source: SourceHealth["source"],
  overrides: Partial<SourceHealth> = {},
): SourceHealth {
  return {
    source,
    status: "healthy",
    lastSuccessAt: iso(NOW - 2_000),
    lastAttemptAt: iso(NOW - 2_000),
    ageMs: 2_000,
    expectedIntervalMs: 10_000,
    latencyMs: 3,
    safeError: null,
    freshness: "fresh",
    detail: null,
    ...overrides,
  };
}

export function container(overrides: Partial<ObservedContainer> = {}): ObservedContainer {
  return {
    name: "app",
    state: "RUNNING",
    status: "Up 2 hours",
    health: null,
    autoStart: true,
    updateFailed: false,
    restartCount: 0,
    healthDetail: null,
    ...overrides,
  };
}

/** ALL_HEALTHY — the everything-nominal observation. */
export function allHealthy(overrides: Partial<IncidentObservation> = {}): IncidentObservation {
  return {
    now: NOW,
    docker: { containers: [container()], running: 1, total: 1 },
    storage: {
      state: "STARTED",
      parityStatus: "COMPLETED",
      disks: [{ name: "disk1", state: "DISK_OK", fsColor: "GREEN", temperatureC: 30 }],
    },
    notifications: { info: 0, warning: 0, alert: 0 },
    vms: { total: 0, running: 0 },
    thermal: { packageC: 55, package5mAvgC: 54, peak1hC: 60, hottestName: "cpu" },
    temperatureSensors: { warningCount: 0, criticalCount: 0 },
    sustainedCpuPercent: 12,
    memoryPercent: 40,
    prometheus: { configured: true, status: "live" },
    helper: { configured: true, reachable: true, reason: null },
    persistence: { dataWritable: true, lastSaveError: null, lastPersistAt: iso(NOW - 5_000) },
    transitions: [],
    sources: [
      sourceHealth("unraid-api"),
      sourceHealth("prometheus"),
      sourceHealth("cadvisor", { expectedIntervalMs: 15_000 }),
      sourceHealth("node-exporter", { expectedIntervalMs: 15_000 }),
      sourceHealth("helper", { expectedIntervalMs: 60_000 }),
      sourceHealth("docker-inventory", { expectedIntervalMs: 60_000 }),
      sourceHealth("persistence", { expectedIntervalMs: 300_000 }),
      sourceHealth("beacon-update", { expectedIntervalMs: 21_600_000 }),
    ],
    topConsumers: [{ name: "app", cpuPercent: 5 }],
    ...overrides,
  };
}

/** DOCKER_UNHEALTHY — Docker states it literally (direct evidence). */
export function dockerUnhealthy(): IncidentObservation {
  return allHealthy({
    docker: {
      containers: [
        container({
          name: "plexdb-ro",
          health: "unhealthy",
          status: "Up 8 minutes (unhealthy)",
          healthDetail: {
            status: "unhealthy",
            failingStreak: 3,
            lastExitCode: 1,
            lastOutput: "sqlite3: database is locked",
            lastCheckedAt: iso(NOW - 30_000),
            lastSuccessAt: iso(NOW - 9 * 60_000),
          },
        }),
      ],
      running: 1,
      total: 1,
    },
  });
}

/** STOPPED_CONTAINERS — states, never incidents. */
export function stoppedContainers(): IncidentObservation {
  return allHealthy({
    docker: {
      containers: [
        container({ name: "on-demand", state: "EXITED", status: "Exited (0) 6 days ago" }),
        container({ name: "also-off", state: "EXITED", status: "Exited (0) 8 days ago", autoStart: false }),
      ],
      running: 0,
      total: 2,
    },
  });
}

/** CRASH_LOOP — Docker's own restarting status, sustained. */
export function crashLoop(): IncidentObservation {
  return allHealthy({
    docker: {
      containers: [
        container({ name: "flaky", status: "Restarting (1) 5 minutes ago", state: "RUNNING" }),
      ],
      running: 1,
      total: 1,
    },
  });
}

/** PROMETHEUS_DOWN — one root incident, dependent values UNKNOWN. */
export function prometheusDown(): IncidentObservation {
  return allHealthy({
    thermal: null,
    sustainedCpuPercent: null,
    prometheus: { configured: true, status: "unavailable" },
    sources: allHealthy().sources.map((entry) =>
      entry.source === "prometheus"
        ? sourceHealth("prometheus", {
            status: "unavailable",
            lastSuccessAt: null,
            ageMs: null,
            freshness: "unknown",
            safeError: "unavailable: cannot reach prometheus",
          })
        : entry,
    ),
  });
}

/** CADVISOR_STALE — scrape target aging out, Prometheus itself fine. */
export function cadvisorStale(): IncidentObservation {
  return allHealthy({
    sources: allHealthy().sources.map((entry) =>
      entry.source === "cadvisor"
        ? sourceHealth("cadvisor", {
            status: "stale",
            lastSuccessAt: iso(NOW - 10 * 60_000),
            ageMs: 10 * 60_000,
            freshness: "stale",
          })
        : entry,
    ),
  });
}

/** HELPER_DEGRADED — configured helper not answering. */
export function helperDegraded(): IncidentObservation {
  return allHealthy({
    helper: { configured: true, reachable: false, reason: "connect timeout" },
    sources: allHealthy().sources.map((entry) =>
      entry.source === "helper"
        ? sourceHealth("helper", {
            status: "unavailable",
            lastSuccessAt: iso(NOW - 20 * 60_000),
            ageMs: 20 * 60_000,
            freshness: "stale",
            safeError: "connect timeout",
          })
        : entry.source === "docker-inventory"
          ? sourceHealth("docker-inventory", { status: "unavailable", safeError: "helper inventory unreachable", lastSuccessAt: iso(NOW - 20 * 60_000), ageMs: 20 * 60_000, freshness: "stale" })
          : entry,
    ),
  });
}

/** UNRAID_API_DOWN — server-state source gone. */
export function unraidApiDown(): IncidentObservation {
  return allHealthy({
    docker: null,
    storage: null,
    notifications: null,
    memoryPercent: null,
    temperatureSensors: null,
    sources: allHealthy().sources.map((entry) =>
      entry.source === "unraid-api"
        ? sourceHealth("unraid-api", {
            status: "unavailable",
            lastSuccessAt: null,
            ageMs: null,
            freshness: "unknown",
            safeError: "unavailable: connection refused",
          })
        : entry,
    ),
  });
}

/** HIGH_TEMP — sustained thermal event with correlated workloads. */
export function highTemp(): IncidentObservation {
  return allHealthy({
    thermal: { packageC: 88, package5mAvgC: 84, peak1hC: 91, hottestName: "cpu" },
    sustainedCpuPercent: 72,
    vms: { total: 3, running: 2 },
    topConsumers: [
      { name: "transcode", cpuPercent: 380 },
      { name: "indexer", cpuPercent: 90 },
    ],
  });
}

/** DISK_HIGH — cache disk over the temperature threshold. */
export function diskHigh(): IncidentObservation {
  return allHealthy({
    storage: {
      state: "STARTED",
      parityStatus: "COMPLETED",
      disks: [
        { name: "cache", state: "DISK_OK", fsColor: "GREEN", temperatureC: 51 },
        { name: "disk1", state: "DISK_OK", fsColor: "GREEN", temperatureC: 30 },
      ],
    },
  });
}

/** MULTIPLE_DEPENDENT_FAILURES — Prometheus AND helper down together. */
export function multipleDependentFailures(): IncidentObservation {
  return prometheusDown();
}

/** PERSISTENCE_FAILURE — the /app/data lesson (Fase 25). */
export function persistenceFailure(): IncidentObservation {
  return allHealthy({
    persistence: { dataWritable: false, lastSaveError: "EROFS: read-only file system, write", lastPersistAt: null },
    sources: allHealthy().sources.map((entry) =>
      entry.source === "persistence"
        ? sourceHealth("persistence", { status: "unavailable", safeError: "EROFS: read-only file system, write" })
        : entry,
    ),
  });
}

/** RECOVERY — a once-unhealthy container now healthy again. */
export function recovered(): IncidentObservation {
  return allHealthy();
}

/** Fresh engine state with the same shape the store hydrates. */
export function freshState(): IncidentsState {
  return {
    version: 1,
    incidents: {},
    lastEvaluatedAt: null,
    baselinedAt: null,
    pending: {},
    restarts: {},
    restartCounts: {},
    toggles: {},
    matchedAt: {},
    presentSince: {},
  };
}
