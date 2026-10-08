import type {
  ContainerHealthDetail,
  Evidence,
  IncidentKind,
  IncidentSeverity,
  SourceId,
} from "@/lib/api-types";
import {
  CRASH_LOOP_MIN_RESTARTS,
  CRASH_LOOP_RESTARTING_SUSTAINED_MS,
  CRASH_LOOP_WINDOW_MS,
  HOST_CPU_SUSTAINED_HIGH_PERCENT,
  HOST_MEM_CRITICAL_PERCENT,
  HOST_MEM_WARNING_PERCENT,
  CPU_TEMP_WARNING_C,
  CPU_TEMP_CRITICAL_C,
  NOTIFICATION_BACKLOG_ALERT_COUNT,
  INCIDENT_DEBOUNCE_MS,
} from "@/server/thresholds";
import { classifyContainerHealth } from "@/lib/container-health";
import { buildEvidence } from "./evidence";
import { parseRestartingStatus, type IncidentObservation, type ObservedContainer } from "./observe";

/**
 * Deterministic incident rules (v1.5.0). Pure functions over the
 * observation (+ persisted trackers) producing RuleCandidates — the
 * engine owns lifecycle, debounce anchors, flapping and persistence.
 *
 * Golden constraints baked into these rules:
 * - a STOPPED container is a state, never an incident (v1.3.8);
 * - update availability is never an incident (update state is separate
 *   from health); a FAILED update is;
 * - a source outage produces ONE root candidate carrying impact —
 *   dependent rules become undecidable instead of emitting per-entity
 *   unknown-value incidents (Fase 6 cascade suppression);
 * - crash-loop requires a proven pattern; one manual restart never does
 *   (Fase 10);
 * - thermal language is "correlated with", never "caused by" unless the
 *   evidence type is direct (Fase 15);
 * - VM workload is never attributed to containers (Fase 16).
 */

export interface RuleCandidate {
  id: string;
  entity: string;
  kind: IncidentKind;
  title: string;
  source: SourceId;
  evidence: Evidence[];
  impact: string[];
  actionable: boolean;
  safeCheck: string | null;
  /** Condition must persist this long before the incident opens. */
  debounceMs: number;
  /**
   * Sources that must be usable for this rule to decide anything. When
   * one is down the candidate is WITHHELD (no incident, no recovery) and
   * impactWhenSuppressed is attributed to the root source incident.
   */
  requiresUsable: SourceId[];
  impactWhenSuppressed: string[];
  severityOverride?: IncidentSeverity | null;
}

export interface RuleOutput {
  candidates: RuleCandidate[];
  /** Fingerprint-level undecidability (source down → rule silent). */
  undecidable: Array<{ fingerprintPrefix: string; source: SourceId; impactHint: string }>;
}

interface Trackers {
  /** container name → restart event timestamps (bounded to window). */
  restarts: Record<string, number[]>;
}

function sourceStatus(observation: IncidentObservation, source: SourceId): string {
  return observation.sources.find((entry) => entry.source === source)?.status ?? "unavailable";
}

function usable(observation: IncidentObservation, source: SourceId): boolean {
  const status = sourceStatus(observation, source);
  return status === "healthy" || status === "degraded";
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/* --------------------------------------------------------------------------
 * Source rules (Fase 2/6/7): one root incident per degraded source,
 * with a static, factual impact map of what becomes UNKNOWN.
 * -------------------------------------------------------------------------- */

const UNRAID_IMPACT = [
  "array/storage state unavailable",
  "docker inventory state unavailable",
  "VM state unavailable",
  "Unraid notifications unavailable",
];

/** True when Prometheus itself is currently out — scrape targets behind
 *  it (cAdvisor, node-exporter) are then UNOBSERVABLE, not independently
 *  broken: their findings collapse into the Prometheus root incident
 *  (one incident, not a cascade — real-outage shape found post-deploy). */
function isPrometheusOutage(observation: IncidentObservation): boolean {
  const prometheus = observation.sources.find((entry) => entry.source === "prometheus");
  return observation.prometheus.configured && prometheus?.status === "unavailable";
}

/** Builds the scrape-target incident for a non-healthy cAdvisor /
 *  node-exporter source with recorded attempts. */
function scrapeSourceIncident(
  observation: IncidentObservation,
  source: IncidentObservation["sources"][number],
): RuleCandidate {
  const isCadvisor = source.source === "cadvisor";
  const unavailable = source.status === "unavailable";
  return {
    id: `source:${source.source}:${unavailable ? "unavailable" : "degraded"}`,
    entity: source.source,
    kind: unavailable ? "source-unavailable" : "source-degraded",
    title: isCadvisor ? "cAdvisor unavailable" : "node-exporter unavailable",
    source: source.source,
    evidence: [
      buildEvidence({
        entity: source.source,
        signal: "source.scrape",
        source: source.source,
        observedAt: source.lastAttemptAt ?? iso(observation.now),
        expectedIntervalMs: source.expectedIntervalMs,
        value: `status=${source.status}${source.safeError ? ` — ${source.safeError}` : ""}`,
        evidenceType: "direct",
        now: observation.now,
      }),
    ],
    impact: isCadvisor
      ? ["per-container CPU/memory metrics unknown", "top-consumer correlation unavailable"]
      : ["host CPU/memory/load metrics unknown", "host thermal metrics unknown", "disk I/O metrics unknown"],
    actionable: false,
    safeCheck: isCadvisor
      ? "Check the cAdvisor container and its Prometheus scrape target."
      : "Check the node-exporter container and its Prometheus scrape target.",
    debounceMs: 0,
    requiresUsable: [],
    impactWhenSuppressed: [],
    severityOverride: "warning",
  };
}

function sourceRules(observation: IncidentObservation): RuleOutput {
  const candidates: RuleCandidate[] = [];
  const undecidable: RuleOutput["undecidable"] = [];
  const sources = observation.sources;

  /* Unraid API — the server-state source. */
  const unraid = sources.find((entry) => entry.source === "unraid-api");
  if (unraid && unraid.status !== "healthy") {
    const unavailable = unraid.status === "unavailable";
    candidates.push({
      id: `source:unraid-api:${unavailable ? "unavailable" : "degraded"}`,
      entity: "unraid-api",
      kind: unavailable ? "source-unavailable" : "source-degraded",
      title: unavailable ? "Unraid API unavailable" : "Unraid API degraded",
      source: "unraid-api",
      evidence: [
        buildEvidence({
          entity: "unraid-api",
          signal: "source.sections",
          source: "unraid-api",
          observedAt: unraid.lastAttemptAt ?? iso(observation.now),
          expectedIntervalMs: unraid.expectedIntervalMs,
          value: `${unraid.detail ?? "sections unusable"}${unraid.safeError ? ` — ${unraid.safeError}` : ""}`,
          evidenceType: "direct",
          now: observation.now,
        }),
      ],
      impact: UNRAID_IMPACT,
      actionable: false,
      safeCheck: "Check that the Unraid API (NGINX) is answering on the configured UNRAID_URL.",
      debounceMs: 0,
      requiresUsable: [],
      impactWhenSuppressed: [],
    });
    undecidable.push(
      { fingerprintPrefix: "storage:", source: "unraid-api", impactHint: "storage rules undecidable (Unraid API down)" },
      { fingerprintPrefix: "docker:container:", source: "unraid-api", impactHint: "docker health rules undecidable (Unraid API down)" },
    );
  }

  /* Prometheus — metrics + history + thermal attribution. */
  const prometheus = sources.find((entry) => entry.source === "prometheus");
  if (observation.prometheus.configured && prometheus && prometheus.status !== "healthy") {
    const unavailable = prometheus.status === "unavailable";
    candidates.push({
      id: `source:prometheus:${unavailable ? "unavailable" : "degraded"}`,
      entity: "prometheus",
      kind: unavailable ? "source-unavailable" : "source-degraded",
      title: unavailable ? "Prometheus unavailable" : "Prometheus degraded",
      source: "prometheus",
      evidence: [
        buildEvidence({
          entity: "prometheus",
          signal: "source.queries",
          source: "prometheus",
          observedAt: prometheus.lastAttemptAt ?? iso(observation.now),
          expectedIntervalMs: prometheus.expectedIntervalMs,
          value: unavailable ? "status=unavailable" : `status=${prometheus.status}${prometheus.safeError ? ` — ${prometheus.safeError}` : ""}`,
          evidenceType: "direct",
          now: observation.now,
        }),
      ],
      impact: [
        "container runtime metrics unknown",
        "host history unavailable",
        "thermal attribution degraded",
        "sustained-CPU classification unavailable",
      ],
      actionable: false,
      safeCheck: "Verify the Prometheus container is running and PROMETHEUS_URL answers.",
      debounceMs: 0,
      requiresUsable: [],
      impactWhenSuppressed: [],
    });
    undecidable.push(
      { fingerprintPrefix: "host:memory", source: "prometheus", impactHint: "memory rules undecidable (Prometheus down)" },
      { fingerprintPrefix: "host:cpu", source: "prometheus", impactHint: "CPU rules undecidable (Prometheus down)" },
      { fingerprintPrefix: "host:thermal", source: "prometheus", impactHint: "thermal rules undecidable (Prometheus down)" },
    );
  }

  /* cAdvisor — container runtime metrics via Prometheus. Only a recorded
     attempt carries evidence ("never observed" is not — e.g. when the
     docker section never loaded because Unraid was down). Suppressed
     under a Prometheus outage: those queries cannot answer either, so
     the metrics fall under the Prometheus ROOT incident (one incident,
     not a cascade). */
  const cadvisor = sources.find((entry) => entry.source === "cadvisor");
  if (
    cadvisor &&
    cadvisor.lastAttemptAt != null &&
    cadvisor.status !== "healthy" &&
    !isPrometheusOutage(observation)
  ) {
    candidates.push(scrapeSourceIncident(observation, cadvisor));
  }

  /* node-exporter — host metrics via Prometheus (same suppression). */
  const nodeExporter = sources.find((entry) => entry.source === "node-exporter");
  if (
    nodeExporter &&
    nodeExporter.lastAttemptAt != null &&
    nodeExporter.status !== "healthy" &&
    !isPrometheusOutage(observation)
  ) {
    candidates.push(scrapeSourceIncident(observation, nodeExporter));
  }

  /* Helper — only an OPERATOR-CONFIGURED helper going down is an incident
     (same semantics as v1.4.x serviceEvents). */
  const helper = sources.find((entry) => entry.source === "helper");
  if (helper && observation.helper.configured && helper.status !== "healthy") {
    candidates.push({
      id: "source:helper:degraded",
      entity: "helper",
      kind: "source-degraded",
      title: "Update helper unreachable",
      source: "helper",
      evidence: [
        buildEvidence({
          entity: "helper",
          signal: "source.reachability",
          source: "helper",
          observedAt: helper.lastAttemptAt ?? iso(observation.now),
          expectedIntervalMs: helper.expectedIntervalMs,
          value: observation.helper.reason ?? "configured helper did not answer /status",
          evidenceType: "direct",
          now: observation.now,
        }),
      ],
      impact: ["docker inventory/update evidence degraded", "in-place container updates unavailable"],
      actionable: false,
      safeCheck: "Check the unraid-dashboard-helper container (binds 127.0.0.1:8790 only).",
      debounceMs: 0,
      requiresUsable: [],
      impactWhenSuppressed: [],
      severityOverride: "warning",
    });
    undecidable.push({ fingerprintPrefix: "docker:container:", source: "helper", impactHint: "restart-count evidence stale (helper down)" });
  }

  /* Persistence — durability of incidents/notifications/history. Only
     PROVEN failure counts: a save error or an unwritable probe. "Never
     observed" (fresh boot, no save yet) is not evidence — opening an
     incident on it was a boot-time false positive (v1.5.0 post-deploy
     finding, fixed on main). */
  const persistenceFailing =
    observation.persistence.lastSaveError != null ||
    observation.persistence.dataWritable === false;
  if (persistenceFailing) {
    candidates.push({
      id: "beacon:persistence",
      entity: "beacon",
      kind: "persistence-failure",
      title: "Persistence failing",
      source: "persistence",
      evidence: [
        buildEvidence({
          entity: "beacon",
          signal: "persistence.save",
          source: "persistence",
          observedAt: iso(observation.now),
          expectedIntervalMs: 300_000,
          value: observation.persistence.lastSaveError
            ? `last save error: ${observation.persistence.lastSaveError}`
            : "data volume not writable",
          evidenceType: "direct",
          now: observation.now,
        }),
      ],
      impact: ["incident history durability degraded", "notification dedupe at risk across restarts"],
      actionable: true,
      safeCheck: "Verify the /app/data volume is mounted read-write (docker template volume mapping).",
      debounceMs: 0,
      requiresUsable: [],
      impactWhenSuppressed: [],
      severityOverride: "critical",
    });
  }

  /* Web Push — only a CONFIGURED path whose LAST delivery attempt failed
     is an incident. "Never attempted" is a valid steady state, not a
     failure (no false positive on fresh installs). */
  const webPush = sources.find((entry) => entry.source === "web-push");
  if (webPush && webPush.lastAttemptAt != null && webPush.safeError != null) {
    candidates.push({
      id: "source:web-push:degraded",
      entity: "web-push",
      kind: "source-degraded",
      title: "Web Push delivery failing",
      source: "web-push",
      evidence: [
        buildEvidence({
          entity: "web-push",
          signal: "push.delivery",
          source: "web-push",
          observedAt: webPush.lastAttemptAt,
          expectedIntervalMs: webPush.expectedIntervalMs,
          value: webPush.safeError,
          evidenceType: "direct",
          now: observation.now,
        }),
      ],
      impact: ["push notifications may not reach devices (in-app delivery unaffected)"],
      actionable: true,
      safeCheck: "Send a test notification from Settings → Notifications to re-probe delivery.",
      debounceMs: 0,
      requiresUsable: [],
      impactWhenSuppressed: [],
      severityOverride: "warning",
    });
  }

  return { candidates, undecidable };
}

/* --------------------------------------------------------------------------
 * Docker rules (Fase 9/10): unhealthy (direct), crash-loop (proven
 * pattern), update-failed. Stopped/paused stay neutral.
 * -------------------------------------------------------------------------- */

function containerHealthEvidence(
  container: ObservedContainer,
  observation: IncidentObservation,
  observedAt: string,
): Evidence[] {
  const evidence: Evidence[] = [
    buildEvidence({
      entity: container.name,
      signal: "docker.health",
      source: "unraid-api",
      observedAt,
      expectedIntervalMs: 10_000,
      value: `health=${container.health ?? "unknown"}`,
      evidenceType: "direct",
      now: observation.now,
    }),
  ];
  const detail: ContainerHealthDetail | null = container.healthDetail;
  if (detail) {
    if (detail.failingStreak != null && detail.failingStreak > 0) {
      evidence.push(
        buildEvidence({
          entity: container.name,
          signal: "docker.healthcheck.failingStreak",
          source: "helper",
          observedAt,
          value: `failingStreak=${detail.failingStreak}`,
          evidenceType: "direct",
          now: observation.now,
        }),
      );
    }
    if (detail.lastExitCode != null && detail.lastExitCode !== 0) {
      evidence.push(
        buildEvidence({
          entity: container.name,
          signal: "docker.healthcheck.exitCode",
          source: "helper",
          observedAt: detail.lastCheckedAt ?? observedAt,
          value: `exitCode=${detail.lastExitCode}${detail.lastOutput ? ` output="${detail.lastOutput}"` : ""}`,
          evidenceType: "direct",
          now: observation.now,
        }),
      );
    }
    if (detail.lastSuccessAt) {
      evidence.push(
        buildEvidence({
          entity: container.name,
          signal: "docker.healthcheck.lastSuccess",
          source: "helper",
          observedAt: detail.lastSuccessAt,
          value: "healthcheck succeeded",
          evidenceType: "direct",
          now: observation.now,
        }),
      );
    }
  }
  return evidence.slice(0, 6);
}

function dockerRules(observation: IncidentObservation, trackers: Trackers): RuleOutput {
  const candidates: RuleCandidate[] = [];
  const undecidable: RuleOutput["undecidable"] = [];
  if (!observation.docker) {
    return { candidates, undecidable };
  }
  const unraidUsable = usable(observation, "unraid-api");
  const dockerAt = iso(observation.now);

  for (const container of observation.docker.containers) {
    const verdict = classifyContainerHealth({
      state: container.state as "RUNNING" | "PAUSED" | "EXITED",
      health: container.health,
      status: container.status,
      updateFailed: container.updateFailed,
    });

    /* Stopped/paused = neutral state, never an incident. */
    if (verdict.classification === "stopped" || verdict.classification === "paused") continue;

    if (verdict.classification === "unhealthy") {
      candidates.push({
        id: `docker:container:${container.name}:unhealthy`,
        entity: container.name,
        kind: "docker-unhealthy",
        title: `Container unhealthy: ${container.name}`,
        source: "unraid-api",
        evidence: containerHealthEvidence(container, observation, dockerAt),
        impact: ["container healthcheck failing — service may be degraded"],
        actionable: true,
        safeCheck: "Inspect the container healthcheck output (Docker page → container detail).",
        debounceMs: 0, // Docker's healthcheck already applies its own semantics
        requiresUsable: ["unraid-api"],
        impactWhenSuppressed: ["docker health unknown (Unraid API down)"],
      });
    }

    /* Crash-loop evidence (Fase 10): either Docker's own restarting status
       sustained, or a restart-count delta pattern in the window —
       evaluated for RUNNING/restarting containers regardless of the
       coarse verdict, because Docker reports "Up X seconds" right after
       an auto-restart (the loop lives in the history, not the status). */
    const restarting = parseRestartingStatus(container.status);
    const events = (trackers.restarts[container.name] ?? []).filter((at) => observation.now - at <= CRASH_LOOP_WINDOW_MS);
    const sustainedRestarting =
      restarting != null && restarting.ageMs != null && restarting.ageMs >= CRASH_LOOP_RESTARTING_SUSTAINED_MS;
    const frequentRestarts = events.length >= CRASH_LOOP_MIN_RESTARTS;
    if (sustainedRestarting || frequentRestarts) {
      candidates.push({
        id: `docker:container:${container.name}:crash-loop`,
        entity: container.name,
        kind: "crash-loop",
        title: `Crash loop: ${container.name}`,
        source: "unraid-api",
        evidence: [
          ...(restarting
            ? [
                buildEvidence({
                  entity: container.name,
                  signal: "docker.status",
                  source: "unraid-api",
                  observedAt: dockerAt,
                  expectedIntervalMs: 10_000,
                  value: `status="${container.status}"`,
                  evidenceType: "direct",
                  now: observation.now,
                }),
              ]
            : []),
          buildEvidence({
            entity: container.name,
            signal: "docker.restartFrequency",
            source: "unraid-api",
            observedAt: dockerAt,
            expectedIntervalMs: 10_000,
            value: `${events.length} restart(s) in ${Math.round(CRASH_LOOP_WINDOW_MS / 60_000)}m window`,
            rule: "crash-loop.frequency",
            evidenceType: "derived",
            now: observation.now,
          }),
        ],
        impact: ["container is restart-looping — workload availability unstable"],
        actionable: true,
        safeCheck: "Inspect container logs for the failing process before any restart change.",
        debounceMs: 0,
        requiresUsable: ["unraid-api"],
        impactWhenSuppressed: ["restart evidence unknown (Unraid API down)"],
      });
    }

    if (container.updateFailed) {
      candidates.push({
        id: `docker:update-failed:${container.name}`,
        entity: container.name,
        kind: "update-failed",
        title: `Update failed: ${container.name}`,
        source: "helper",
        evidence: [
          buildEvidence({
            entity: container.name,
            signal: "update.machine.result",
            source: "helper",
            observedAt: dockerAt,
            value: "update machine reported failure",
            evidenceType: "direct",
            now: observation.now,
          }),
        ],
        impact: ["container still runs the previous image"],
        actionable: true,
        safeCheck: "Review the update job log (Docker → Updates) before retrying.",
        debounceMs: 0,
        requiresUsable: ["helper"],
        impactWhenSuppressed: ["update outcome unknown (helper down)"],
      });
    }
  }

  if (!unraidUsable) {
    undecidable.push({ fingerprintPrefix: "docker:container:", source: "unraid-api", impactHint: "docker health unknown (Unraid API down)" });
  }
  return { candidates, undecidable };
}

/* --------------------------------------------------------------------------
 * Storage rules: array state + disk state (critical, direct) and disk
 * thermals (warning). Preserves v1.4.x semantics unchanged.
 * -------------------------------------------------------------------------- */

const ARRAY_OK = new Set(["STARTED"]);
const DISK_OK_STATES = new Set(["DISK_OK", "DISK_NP", "DISK_DSBL_NP"]);
const DISK_TEMP_WARNING_C = 45;

function storageRules(observation: IncidentObservation): RuleOutput {
  const candidates: RuleCandidate[] = [];
  const undecidable: RuleOutput["undecidable"] = [];
  if (!observation.storage) {
    return { candidates, undecidable };
  }
  const at = iso(observation.now);

  if (observation.storage.state && !ARRAY_OK.has(observation.storage.state)) {
    candidates.push({
      id: `storage:array:${observation.storage.state}`,
      entity: "array",
      kind: "array-state",
      title: `Array ${observation.storage.state.replaceAll("_", " ").toLowerCase()}`,
      source: "unraid-api",
      evidence: [
        buildEvidence({
          entity: "array",
          signal: "array.state",
          source: "unraid-api",
          observedAt: at,
          expectedIntervalMs: 60_000,
          value: `state=${observation.storage.state}`,
          evidenceType: "direct",
          now: observation.now,
        }),
      ],
      impact: ["array not in nominal started state — shares/services may be unavailable"],
      actionable: true,
      safeCheck: "Check the array state on the Storage page before any action.",
      debounceMs: 0,
      requiresUsable: ["unraid-api"],
      impactWhenSuppressed: ["array state unknown (Unraid API down)"],
    });
  }

  for (const disk of observation.storage.disks) {
    const broken = disk.fsColor === "RED" || disk.fsColor === "RED_BALL" || (disk.state != null && !DISK_OK_STATES.has(disk.state));
    const hot = !broken && disk.temperatureC != null && disk.temperatureC >= DISK_TEMP_WARNING_C;
    if (broken) {
      candidates.push({
        id: `storage:disk:${disk.name}:critical`,
        entity: disk.name,
        kind: "disk-state",
        title: `Disk ${disk.name} critical`,
        source: "unraid-api",
        evidence: [
          buildEvidence({
            entity: disk.name,
            signal: "disk.state",
            source: "unraid-api",
            observedAt: at,
            expectedIntervalMs: 60_000,
            value: `state=${disk.state ?? "unknown"}${disk.fsColor ? ` fsColor=${disk.fsColor}` : ""}`,
            evidenceType: "direct",
            now: observation.now,
          }),
        ],
        impact: ["disk reports a failure state — data-integrity risk"],
        actionable: true,
        safeCheck: "Review the disk status on the Storage page; no write action is taken by Beacon.",
        debounceMs: 0,
        requiresUsable: ["unraid-api"],
        impactWhenSuppressed: ["disk state unknown (Unraid API down)"],
      });
    } else if (hot) {
      candidates.push({
        id: `storage:disk:${disk.name}:warning`,
        entity: disk.name,
        kind: "disk-thermal",
        title: `Disk ${disk.name} hot`,
        source: "unraid-api",
        evidence: [
          buildEvidence({
            entity: disk.name,
            signal: "disk.temperatureC",
            source: "unraid-api",
            observedAt: at,
            expectedIntervalMs: 900_000,
            value: `temperatureC=${disk.temperatureC} (threshold ${DISK_TEMP_WARNING_C})`,
            rule: "disk-thermal.threshold",
            evidenceType: "derived",
            now: observation.now,
          }),
        ],
        impact: ["disk above temperature threshold"],
        actionable: true,
        safeCheck: "Check airflow/disk load; temperature readings come from Unraid S.M.A.R.T.",
        debounceMs: INCIDENT_DEBOUNCE_MS["disk-thermal"],
        requiresUsable: ["unraid-api"],
        impactWhenSuppressed: ["disk temperature unknown (Unraid API down)"],
      });
    }
  }

  return { candidates, undecidable };
}

/* --------------------------------------------------------------------------
 * Resource rules (Fase 14/16): memory + sustained CPU. Debounced — one
 * spike is not an incident. VM workloads are NEVER attributed to
 * containers here.
 * -------------------------------------------------------------------------- */

function resourceRules(observation: IncidentObservation): RuleOutput {
  const candidates: RuleCandidate[] = [];
  const undecidable: RuleOutput["undecidable"] = [];
  const at = iso(observation.now);
  /* Host memory % is Unraid-sourced (authoritative); sustained CPU comes
     from Prometheus. Source usability is NOT pre-checked here — the
     candidates always emit and the engine withholds them when the source
     is down, attributing their impact to the ROOT source incident. */

  if (observation.memoryPercent != null) {
    if (observation.memoryPercent >= HOST_MEM_WARNING_PERCENT) {
      const critical = observation.memoryPercent >= HOST_MEM_CRITICAL_PERCENT;
      candidates.push({
        id: critical ? "host:memory:critical" : "host:memory:warning",
        entity: "host",
        kind: "memory-pressure",
        title: `Memory pressure at ${Math.round(observation.memoryPercent)}%`,
        source: "unraid-api",
        evidence: [
          buildEvidence({
            entity: "host",
            signal: "host.memoryPercent",
            source: "unraid-api",
            observedAt: at,
            expectedIntervalMs: 5_000,
            value: `${Math.round(observation.memoryPercent)}% (warning ${HOST_MEM_WARNING_PERCENT}, critical ${HOST_MEM_CRITICAL_PERCENT})`,
            rule: "host.memory",
            evidenceType: "derived",
            now: observation.now,
          }),
        ],
        impact: ["host memory pressure — OOM risk grows as usage climbs"],
        actionable: true,
        safeCheck: "Review top memory consumers on the Docker page (VM memory is shown separately on the VMs page).",
        debounceMs: INCIDENT_DEBOUNCE_MS["memory-pressure"],
        requiresUsable: ["unraid-api"],
        impactWhenSuppressed: ["memory classification unknown (Unraid API down)"],
        severityOverride: critical ? "critical" : "warning",
      });
    }
  }

  if (observation.sustainedCpuPercent != null && observation.sustainedCpuPercent >= HOST_CPU_SUSTAINED_HIGH_PERCENT) {
    candidates.push({
      id: "host:cpu:sustained",
      entity: "host",
      kind: "cpu-sustained",
      title: `Sustained CPU load at ${Math.round(observation.sustainedCpuPercent)}%`,
      source: "prometheus",
      evidence: [
        buildEvidence({
          entity: "host",
          signal: "host.cpu.sustained5m",
          source: "prometheus",
          observedAt: at,
          expectedIntervalMs: 15_000,
          value: `${Math.round(observation.sustainedCpuPercent)}% averaged over 5 minutes (threshold ${HOST_CPU_SUSTAINED_HIGH_PERCENT})`,
          rule: "host.cpu.sustained",
          evidenceType: "derived",
          now: observation.now,
        }),
      ],
      impact: ["sustained host CPU load"],
      actionable: false,
      safeCheck: "Compare top consumers (containers) and VM workload before acting.",
      debounceMs: INCIDENT_DEBOUNCE_MS["cpu-sustained"],
      requiresUsable: ["prometheus"],
      impactWhenSuppressed: ["CPU classification unknown (Prometheus down)"],
      severityOverride: "warning",
    });
  }

  return { candidates, undecidable };
}

/* --------------------------------------------------------------------------
 * Thermal rules (Fase 15): sustained heat is WARNING; evidence carries
 * temp + threshold + correlated workloads with correlation language.
 * -------------------------------------------------------------------------- */

function thermalRules(observation: IncidentObservation): RuleOutput {
  const candidates: RuleCandidate[] = [];
  const undecidable: RuleOutput["undecidable"] = [];
  const at = iso(observation.now);

  const package5m = observation.thermal?.package5mAvgC ?? null;
  if (package5m != null && package5m >= CPU_TEMP_WARNING_C) {
    const atCriticalBand = package5m >= CPU_TEMP_CRITICAL_C;
    const evidence: Evidence[] = [
      buildEvidence({
        entity: "host",
        signal: "thermal.package5mAvgC",
        source: "prometheus",
        observedAt: at,
        expectedIntervalMs: 30_000,
        value: `${Math.round(package5m)}°C averaged over 5 minutes (warning ${CPU_TEMP_WARNING_C}°C, critical ${CPU_TEMP_CRITICAL_C}°C)`,
        rule: "thermal.package5m",
        evidenceType: "derived",
        now: observation.now,
      }),
    ];
    const correlated = (observation.topConsumers ?? []).slice(0, 3);
    const vmsRunning = observation.vms?.running ?? 0;
    const correlationParts = correlated.map((entry) => `${entry.name} (${entry.cpuPercent != null ? `${Math.round(entry.cpuPercent)}%` : "cpu ?"})`);
    if (vmsRunning > 0) {
      correlationParts.push(`${vmsRunning} running VM workload(s) — VM CPU is NOT attributable to containers`);
    }
    if (correlationParts.length > 0) {
      evidence.push(
        buildEvidence({
          entity: "host",
          signal: "thermal.correlatedWorkloads",
          source: "prometheus",
          observedAt: at,
          expectedIntervalMs: 5_000,
          value: `correlated with: ${correlationParts.join(", ")}`,
          rule: "thermal.correlation",
          evidenceType: "correlated",
          now: observation.now,
        }),
      );
    }
    candidates.push({
      id: "host:thermal:package",
      entity: "host",
      kind: "thermal",
      title: atCriticalBand
        ? `CPU package averaging ${Math.round(package5m)}°C — critical band`
        : `CPU package averaging ${Math.round(package5m)}°C`,
      source: "prometheus",
      evidence,
      impact: ["sustained package temperature above the warning threshold"],
      actionable: true,
      safeCheck: "Check case airflow and recent load; Beacon correlates but never claims causation.",
      debounceMs: INCIDENT_DEBOUNCE_MS.thermal,
      requiresUsable: ["prometheus"],
      impactWhenSuppressed: ["thermal attribution unavailable (Prometheus down)"],
      severityOverride: "warning",
    });
  }

  /* Unraid-side sensor counts (owner-configured critical thresholds). */
  const sensors = observation.temperatureSensors;
  if (sensors && sensors.criticalCount > 0) {
    candidates.push({
      id: "host:thermal:unraid-sensors",
      entity: "host",
      kind: "thermal",
      title: `${sensors.criticalCount} temperature sensor(s) past critical threshold`,
      source: "unraid-api",
      evidence: [
        buildEvidence({
          entity: "host",
          signal: "unraid.temperature.criticalCount",
          source: "unraid-api",
          observedAt: at,
          expectedIntervalMs: 900_000,
          value: `criticalCount=${sensors.criticalCount} warningCount=${sensors.warningCount}`,
          evidenceType: "direct",
          now: observation.now,
        }),
      ],
      impact: ["hardware sensors report sustained over-threshold temperature"],
      actionable: true,
      safeCheck: "Identify the sensor on the System page; no remediation is automated.",
      debounceMs: 0,
      requiresUsable: ["unraid-api"],
      impactWhenSuppressed: ["sensor state unknown (Unraid API down)"],
      severityOverride: "warning",
    });
  }

  return { candidates, undecidable };
}

/* --------------------------------------------------------------------------
 * Notification backlog (Fase 17): INFO, review-oriented. Never critical.
 * -------------------------------------------------------------------------- */

function backlogRule(observation: IncidentObservation): RuleOutput {
  const candidates: RuleCandidate[] = [];
  const undecidable: RuleOutput["undecidable"] = [];
  if (!observation.notifications) return { candidates, undecidable };
  if (observation.notifications.alert >= NOTIFICATION_BACKLOG_ALERT_COUNT) {
    candidates.push({
      id: "beacon:notifications:backlog",
      entity: "unraid-notifications",
      kind: "notification-backlog",
      title: `${observation.notifications.alert} unread Unraid alert notification(s)`,
      source: "unraid-api",
      evidence: [
        buildEvidence({
          entity: "unraid-notifications",
          signal: "unraid.notifications.unread",
          source: "unraid-api",
          observedAt: iso(observation.now),
          expectedIntervalMs: 60_000,
          value: `alert=${observation.notifications.alert} warning=${observation.notifications.warning} info=${observation.notifications.info}`,
          evidenceType: "direct",
          now: observation.now,
        }),
      ],
      impact: ["Unraid notification backlog awaiting review"],
      actionable: true,
      safeCheck: "Review the Notifications page — live conditions get their own incidents.",
      debounceMs: 0,
      requiresUsable: ["unraid-api"],
      impactWhenSuppressed: ["notification backlog unknown (Unraid API down)"],
      severityOverride: "info",
    });
  }
  return { candidates, undecidable };
}

/** Runs every rule set. Errors in one rule never take down the cycle. */
export function evaluateRules(observation: IncidentObservation, trackers: Trackers): RuleOutput {
  const output: RuleOutput = { candidates: [], undecidable: [] };
  const ruleSets = [
    () => sourceRules(observation),
    () => dockerRules(observation, trackers),
    () => storageRules(observation),
    () => resourceRules(observation),
    () => thermalRules(observation),
    () => backlogRule(observation),
  ];
  for (const ruleSet of ruleSets) {
    try {
      const result = ruleSet();
      output.candidates.push(...result.candidates);
      output.undecidable.push(...result.undecidable);
    } catch {
      // A broken rule must never break the whole incident cycle.
    }
  }
  return output;
}
