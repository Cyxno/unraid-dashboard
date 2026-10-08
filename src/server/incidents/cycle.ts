import type {
  HealthSummary,
  Incident,
  ObservabilityConfidence,
  SourceHealth,
} from "@/lib/api-types";
import { getVms } from "@/server/unraid/service";
import { applyIncidentCycle } from "./engine";
import { buildObservation } from "./observe";
import { getPersistenceHealth } from "./persistence-check";
import {
  ensureIncidentsState,
  loadIncidentsState,
  pruneIncidents,
  scheduleIncidentsSave,
} from "./store";
import { getAllSourceHealth } from "./source-health";

/**
 * Incident cycle orchestrator (v1.5.0).
 *
 * Runs on the EXISTING overview cadence — `getOverview()` invokes it with
 * the payload it just assembled, so the engine consumes only cached data
 * (section TTL caches, in-memory transitions, 30s-cached helper status).
 * ZERO new upstream polling: no per-card Prometheus queries, no per-
 * incident Unraid queries, no N+1 docker inspects (Fase 30).
 *
 * The result is cached process-wide for the API/UI surfaces; the state
 * file is saved debounced.
 */

export interface IncidentSnapshot {
  active: Incident[];
  recovered: Incident[];
  counts: { critical: number; warning: number; info: number; active: number };
  health: HealthSummary;
  sources: SourceHealth[];
  confidence: ObservabilityConfidence;
  evaluatedAt: string | null;
}

const globalStore = globalThis as unknown as {
  __incidentSnapshot?: IncidentSnapshot;
  __incidentCycleBusy?: boolean;
};

export function currentIncidentSnapshot(): IncidentSnapshot {
  if (globalStore.__incidentSnapshot) return globalStore.__incidentSnapshot;
  return emptySnapshot();
}

function emptySnapshot(): IncidentSnapshot {
  return {
    active: [],
    recovered: [],
    counts: { critical: 0, warning: 0, info: 0, active: 0 },
    health: { level: null, reasons: [] },
    sources: getAllSourceHealth(),
    confidence: { level: "full", reasons: [] },
    evaluatedAt: null,
  };
}

function summarize(active: Incident[], _recovered: Incident[]): IncidentSnapshot["counts"] {
  return {
    critical: active.filter((incident) => incident.severity === "critical").length,
    warning: active.filter((incident) => incident.severity === "warning").length,
    info: active.filter((incident) => incident.severity === "info").length,
    active: active.length,
  };
}

export function publishSnapshot(active: Incident[], _recovered: Incident[], health: HealthSummary, confidence: ObservabilityConfidence): void {
  const state = loadIncidentsState();
  const recoveredHistory = Object.values(state.incidents)
    .filter((incident) => incident.status === "recovered")
    .sort((a, b) => Date.parse(b.resolvedAt ?? b.lastSeenAt) - Date.parse(a.resolvedAt ?? a.lastSeenAt))
    .slice(0, 50);
  globalStore.__incidentSnapshot = {
    active,
    recovered: recoveredHistory,
    counts: summarize(active, recoveredHistory),
    health,
    sources: getAllSourceHealth(),
    confidence,
    evaluatedAt: state.lastEvaluatedAt,
  };
}

/**
 * Runs one incident evaluation against an ALREADY-FETCHED overview
 * payload. Safe to call concurrently (single-flight). Never throws —
 * observability must not take the dashboard down.
 */
export async function runIncidentCycle(
  payload: Parameters<typeof buildObservation>[0],
): Promise<IncidentSnapshot> {
  if (globalStore.__incidentCycleBusy) {
    return currentIncidentSnapshot();
  }
  globalStore.__incidentCycleBusy = true;
  try {
    await ensureIncidentsState();
    const state = loadIncidentsState();

    const observation = await buildObservation(payload);

    /* VM state is needed for workload attribution (Fase 16) — the
       provider is TTL-cached (30s), so this adds no Unraid load. */
    try {
      const vms = await getVms();
      observation.vms = vms.data
        ? { total: vms.data.total, running: vms.data.running }
        : null;
    } catch {
      observation.vms = null;
    }

    /* Persistence self-check (cached 60s; Fase 25). */
    try {
      const persistence = await getPersistenceHealth();
      observation.persistence.dataWritable = persistence.dataDirWritable;
      observation.persistence.lastPersistAt = persistence.lastPersistAt ?? observation.persistence.lastPersistAt;
      if (persistence.failing && !observation.persistence.lastSaveError) {
        observation.persistence.lastSaveError = persistence.probeError ?? "persistence probe failed";
      }
    } catch {
      observation.persistence.dataWritable = null;
    }

    const output = applyIncidentCycle({ observation, state });
    state.incidents = pruneIncidents(state.incidents, Date.now());
    scheduleIncidentsSave();
    publishSnapshot(output.active, output.recoveredNow, output.health, output.confidence);
    return globalStore.__incidentSnapshot!;
  } catch {
    // Never break the overview path on an incident-engine failure.
    return currentIncidentSnapshot();
  } finally {
    globalStore.__incidentCycleBusy = false;
  }
}

/** Test hook: clears the process-wide snapshot. */
export function resetIncidentCycleCache(): void {
  globalStore.__incidentSnapshot = undefined;
}
