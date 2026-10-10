import type {
  Incident,
  RemediationAction,
  RemediationActionType,
  Runbook,
  RunbookStep,
} from "@/lib/api-types";

/**
 * Canonical remediation catalog + deterministic runbooks (v1.7.0 Fase 1/2/12).
 *
 * Every remediation step Beacon can offer is defined HERE — pure data, no
 * scattered action logic in the UI. The executor is a fixed switch over
 * RemediationActionType; manual-only guidance never has an execute path.
 *
 * Safety invariants (enforced by tests):
 * - diagnostics are read-only over Beacon's own caches/state;
 * - guarded actions are the ALREADY-EXISTING confirmed mutations
 *   (docker start/stop, verified container update) — nothing new;
 * - there is no restart action (Unraid 7.3.2 API exposes start/stop only
 *   and restart was deliberately never surfaced);
 * - thermal/capacity/disk/array guidance is manual-only, always;
 * - no free-form text, no AI/LLM, no shell commands, no secrets.
 */

const DIAGNOSTIC_COOLDOWN_MS = 30_000;
const PUSH_COOLDOWN_MS = 60_000;
const CONTAINER_ACTION_COOLDOWN_MS = 10_000;

/* --------------------------------------------------------------------------
 * Diagnostic actions (Fase 3): safe, non-mutating, cooldown-bounded.
 * -------------------------------------------------------------------------- */

function diagnosticAction(
  type: RemediationActionType,
  incident: Incident,
  title: string,
  description: string,
  cooldownMs: number,
): RemediationAction {
  return {
    id: `diagnostic:${type}`,
    incidentId: incident.id,
    entity: incident.entity,
    type,
    title,
    description,
    risk: "safe",
    requiresConfirmation: false,
    requiresPrivilege: "none",
    reversible: true,
    preconditions: ["incident still active", "no conflicting operation"],
    verification: ["fresh evidence appears in the incident (observedAt updated)"],
    cooldownMs,
  };
}

/* --------------------------------------------------------------------------
 * Guarded actions (Fase 4): ONLY the pre-existing confirmed mutations,
 * offered solely where they are the logical next step for the incident.
 * -------------------------------------------------------------------------- */

function containerAction(
  type: "docker-start" | "docker-stop",
  incident: Incident,
  title: string,
  description: string,
): RemediationAction {
  return {
    id: `guarded:${type}`,
    incidentId: incident.id,
    entity: incident.entity,
    type,
    title,
    description,
    risk: "guarded",
    requiresConfirmation: true,
    requiresPrivilege: "actions",
    reversible: true,
    preconditions: [
      "write actions enabled on this server",
      "container present in the live inventory with a known state",
      "no conflicting operation on this container",
      "no dashboard update in progress",
      "cooldown clear",
    ],
    verification: [
      type === "docker-start"
        ? "Docker reports the container RUNNING from the live inventory"
        : "Docker reports the container EXITED from the live inventory",
      "incident engine re-evaluates on the next cycle",
    ],
    cooldownMs: CONTAINER_ACTION_COOLDOWN_MS,
  };
}

function updateRetryAction(incident: Incident): RemediationAction {
  return {
    id: "guarded:verified-update-retry",
    incidentId: incident.id,
    entity: incident.entity,
    type: "verified-update-retry",
    title: "Retry verified container update",
    description:
      "Re-runs the existing verified per-container update flow (snapshot → pull → digest verify → recreate → health wait) with preconditions re-checked just before execution.",
    risk: "guarded",
    requiresConfirmation: true,
    requiresPrivilege: "helper",
    reversible: true,
    preconditions: [
      "update helper healthy",
      "helper not in an active update phase",
      "no conflicting operation on this container",
      "rollback snapshot available from the previous attempt",
      "cooldown clear",
    ],
    verification: [
      "helper job reaches a terminal phase with health verified",
      "container runs the target image and the update-failed incident clears",
    ],
    cooldownMs: 60_000,
  };
}

/* --------------------------------------------------------------------------
 * Runbooks (Fase 2/12): deterministic, evidence-based, per incident kind.
 * -------------------------------------------------------------------------- */

function step(title: string, detail: string): RunbookStep {
  return { title, detail };
}

const REFRESH_EVIDENCE_RUNBOOK_STEP: RunbookStep = step(
  "Refresh incident evidence",
  "Re-run the incident evaluation over the latest cached data (no new upstream polling) and compare fresh evidence with what you saw before acting.",
);

function baseRunbook(scope: string, explanation: string): Runbook {
  return {
    scope,
    explanation,
    prerequisites: [],
    diagnosticChecks: [],
    actionIds: ["diagnostic:refresh-incident-evidence"],
    verification: [],
    manualRecovery: [],
    escalation: "Escalate when the evidence worsens, the incident escalates to critical, or recovery cannot be proven.",
  };
}

function containerRunbook(incident: Incident, scope: "docker-unhealthy" | "crash-loop"): Runbook {
  const runbook = baseRunbook(
    scope,
    scope === "docker-unhealthy"
      ? "Docker's own healthcheck reports the container unhealthy. Beacon observes and proves this with evidence; it never restarts anything on its own."
      : "The container shows a proven restart pattern (sustained restarting status or repeated restart deltas inside the window). One manual restart is never classified as a crash loop.",
  );
  runbook.prerequisites = [
    "Unraid API usable (docker health evidence requires it)",
    scope === "crash-loop" ? "restart pattern evidence is present in this incident" : "healthcheck evidence is present in this incident",
  ];
  runbook.diagnosticChecks =
    scope === "docker-unhealthy"
      ? [
          step("Inspect healthcheck output", "Open the container detail page — the failing streak, last exit code and last healthcheck output are shown from the helper inventory."),
          step("Verify dependent services", "A healthcheck usually probes a dependency (port, database, endpoint). Confirm that dependency is reachable."),
          step("Check source freshness", "Confirm the evidence in this incident is fresh; stale evidence means the observation layer itself needs attention first."),
          REFRESH_EVIDENCE_RUNBOOK_STEP,
        ]
      : [
          step("Inspect restart evidence", "The incident shows the restart pattern: how many restarts in the window, plus the sustained restarting status if applicable."),
          step("Read container logs", "Open the container detail page and read the logs of the failing process before considering any lifecycle change."),
          step("Correlate with update/deploy history", "Check the container's update history — a crash loop that started right after an update is a rollback candidate, not a restart candidate."),
          REFRESH_EVIDENCE_RUNBOOK_STEP,
        ];
  runbook.actionIds =
    scope === "crash-loop"
      ? ["diagnostic:refresh-incident-evidence", "guarded:docker-stop"]
      : ["diagnostic:refresh-incident-evidence"];
  runbook.verification = [
    step("Health observed healthy", "Docker reports the container running with passing healthchecks over multiple consecutive checks."),
    step("Incident recovered", "This incident closes itself when the engine positively observes the condition absent — that is the proof of recovery, not the API response."),
  ];
  runbook.manualRecovery =
    scope === "docker-unhealthy"
      ? [
          "Fix the underlying application problem the healthcheck exposes.",
          "If the container is misconfigured, correct its template/config in the Unraid Docker UI and apply it there.",
          "If a restart is appropriate, perform it yourself in the Unraid Docker UI — Beacon offers no restart action by design.",
        ]
      : [
          "Stop the container from this runbook (confirmed action) if it is crash-looping in a way that harms other workloads.",
          "Fix the failing process or configuration in the Unraid Docker UI.",
          "Start the container again from the Docker page once the cause is fixed (existing confirmed action).",
        ];
  runbook.escalation =
    scope === "docker-unhealthy"
      ? "The incident escalates to critical automatically after the sustained-unhealthy window."
      : "Escalate when restarts continue after a configuration fix, or when the crash loop correlates with a failed update (use the update-failure runbook then).";
  return runbook;
}

function sourceRunbook(incident: Incident): Runbook {
  const entity = incident.entity;
  const specifics: Record<string, { explanation: string; checks: RunbookStep[]; manual: string[] }> = {
    "unraid-api": {
      explanation: "The Unraid GraphQL API is not answering normally. Everything Beacon knows about server state (array, docker, VMs, notifications) depends on it; dependent rules are withheld rather than guessing.",
      checks: [
        step("Check last success and age", "The source panel below shows the last successful fetch, its age and the safe error text."),
        step("Check API reachability", "Confirm the Unraid API (NGINX) answers on the configured UNRAID_URL from a browser."),
        REFRESH_EVIDENCE_RUNBOOK_STEP,
      ],
      manual: [
        "Verify the Unraid API/NGINX service is running on the Unraid host.",
        "Verify the API key has not expired or been rotated.",
      ],
    },
    prometheus: {
      explanation: "Prometheus is not answering queries. Metrics, history and thermal attribution degrade; dependent incidents are held, not falsely recovered.",
      checks: [
        step("Check last success and age", "The source panel shows the last successful query, its age and the safe error."),
        step("Check the Prometheus container", "Confirm the Prometheus container is running and PROMETHEUS_URL answers."),
        REFRESH_EVIDENCE_RUNBOOK_STEP,
      ],
      manual: ["Inspect the Prometheus container in the Unraid Docker UI; check its logs and scrape targets."],
    },
    cadvisor: {
      explanation: "cAdvisor metrics are not arriving through Prometheus. Per-container CPU/memory and top-consumer correlation are unknown while this persists.",
      checks: [
        step("Check scrape evidence", "The incident carries the recorded scrape attempts and the safe error text."),
        step("Check the cAdvisor container", "Confirm cAdvisor is running and Prometheus can reach its scrape target."),
        REFRESH_EVIDENCE_RUNBOOK_STEP,
      ],
      manual: ["Inspect the cAdvisor container and its Prometheus scrape target configuration."],
    },
    "node-exporter": {
      explanation: "node-exporter metrics are not arriving through Prometheus. Host CPU/memory/load and thermal metrics are unknown while this persists.",
      checks: [
        step("Check scrape evidence", "The incident carries the recorded scrape attempts and the safe error text."),
        step("Check the node-exporter container", "Confirm node-exporter is running and Prometheus can reach its scrape target."),
        REFRESH_EVIDENCE_RUNBOOK_STEP,
      ],
      manual: ["Inspect the node-exporter container and its Prometheus scrape target configuration."],
    },
    helper: {
      explanation: "The update helper does not answer /status. Docker inventory healthcheck evidence and in-place container updates are degraded. The helper is the ONLY component with Docker-socket access — never widen its privileges to 'fix' this.",
      checks: [
        step("Check reachability evidence", "The incident carries the recorded /status attempts and the safe error."),
        step("Check the helper container", "Confirm the unraid-dashboard-helper container is running; it binds 127.0.0.1:8790 only."),
        REFRESH_EVIDENCE_RUNBOOK_STEP,
      ],
      manual: [
        "Inspect the unraid-dashboard-helper container in the Unraid Docker UI.",
        "Verify the UPDATE_HELPER_TOKEN matches between Beacon and the helper.",
      ],
    },
    "web-push": {
      explanation: "The last Web Push delivery attempt failed. In-app delivery is unaffected; devices may miss push notifications until the registration or provider path is repaired.",
      checks: [
        step("Run the push diagnostics flow", "Settings → Notifications walks permission → service worker → subscription → server registration → fingerprint → provider acceptance, each with its own trace."),
        step("Send a test notification", "A test push is the re-probe: 'pushed' means the provider accepted — that is not proof a device rendered it."),
        REFRESH_EVIDENCE_RUNBOOK_STEP,
      ],
      manual: [
        "Use 'Repair this device' on the affected device (re-registers its subscription).",
        "Do NOT rotate VAPID keys unless the provider path itself is proven broken — rotating breaks every existing subscription.",
      ],
    },
  };
  const specific = specifics[entity] ?? {
    explanation: "A data source is degraded; dependent values read UNKNOWN rather than zero while the outage lasts.",
    checks: [REFRESH_EVIDENCE_RUNBOOK_STEP],
    manual: ["Check the affected service and its configuration."],
  };
  const runbook = baseRunbook(incident.kind, specific.explanation);
  runbook.diagnosticChecks = specific.checks;
  runbook.manualRecovery = specific.manual;
  runbook.verification = [
    step("Source healthy again", "The source reports status healthy with a fresh last-success timestamp."),
    step("Dependent incidents recover", "Suppressed dependent rules re-evaluate automatically — recovery is proven when the root incident closes and no dependent value stays UNKNOWN."),
  ];
  runbook.actionIds = ["diagnostic:refresh-incident-evidence"];
  if (entity === "web-push") {
    runbook.actionIds.push("diagnostic:re-probe-push-delivery");
  }
  runbook.escalation = "Beacon never restarts a source service automatically. Escalate to manual inspection when the outage outlives the source's own healthcheck/restart policy.";
  return runbook;
}

function persistenceRunbook(incident: Incident): Runbook {
  const runbook = baseRunbook(
    incident.kind,
    "Beacon cannot prove durable writes to its data volume. Incident history, notification dedupe and dashboards are at risk across restarts. Only PROVEN failures open this incident (a real save error or a failed write probe).",
  );
  runbook.diagnosticChecks = [
    step("Re-run the persistence probe", "The probe writes and removes a uniquely-named temp file in the data directory — it never touches state files."),
    step("Check the expected path", "The diagnostics panel shows the configured data directory and whether it exists."),
    step("Check mount detection", "Verify the container template maps the data volume read-write (not a fresh anonymous volume)."),
    step("Check last successful write", "The diagnostics panel shows when Beacon last persisted successfully."),
  ];
  runbook.actionIds = ["diagnostic:re-run-persistence-probe", "diagnostic:refresh-incident-evidence"];
  runbook.verification = [
    step("Probe succeeds again", "A fresh probe reports the data directory writable."),
    step("State file updates", "A new save succeeds without a recorded save error and the incident clears on the next cycle."),
  ];
  runbook.manualRecovery = [
    "Fix the volume mapping in the container template (host path → /app/data, read-write).",
    "Recreate the container from the corrected template yourself — Beacon never changes mounts or file permissions automatically.",
  ];
  runbook.escalation = "Escalate immediately: while persistence is broken, recovered-incident history and notification dedupe are not durable.";
  return runbook;
}

function updateFailureRunbook(incident: Incident): Runbook {
  const runbook = baseRunbook(
    incident.kind,
    "A verified container update failed. The container still runs the previous image. The verified update flow already holds a rollback snapshot from the attempt.",
  );
  runbook.diagnosticChecks = [
    step("Read the operation trace", "The update job log (Docker → Updates / container detail) shows the exact phase the update failed in: resolving, pulling, snapshot, recreating or health check."),
    step("Check helper status", "Confirm the helper is healthy and not stuck in an active update phase."),
    step("Check rollback status", "The snapshot from the failed attempt is listed in the update history with its provenance."),
    step("Re-check registry state", "Confirm the target image/version is still resolvable in the registry."),
  ];
  runbook.actionIds = ["diagnostic:re-check-registry", "diagnostic:refresh-incident-evidence", "guarded:verified-update-retry"];
  runbook.verification = [
    step("Helper job terminal and healthy", "A retried update must reach a terminal phase with health verification — an accepted request alone proves nothing."),
    step("Incident clears", "The update-failed incident closes when the engine observes the container healthy on the new image."),
  ];
  runbook.manualRecovery = [
    "If the target image itself is broken, roll back from the update history (existing confirmed rollback flow).",
    "If the registry credentials are the problem, fix them in the Unraid registry configuration first — do not retry blindly.",
  ];
  runbook.escalation = "Retry ONLY when every precondition is green again. Escalate to rollback when a second verified attempt fails at the same phase.";
  return runbook;
}

function thermalRunbook(incident: Incident): Runbook {
  const isDisk = incident.kind === "disk-thermal";
  const runbook = baseRunbook(
    incident.kind,
    isDisk
      ? "A disk reports a temperature above its threshold. Beacon shows guidance only — it never kills workloads or touches fans."
      : "Sustained CPU package temperature above the warning threshold. Beacon correlates workloads but never claims causation unless the evidence is direct, and never remediates automatically.",
  );
  runbook.diagnosticChecks = [
    step("Read the temperature evidence", "The incident shows the current value, threshold and how long it has been sustained."),
    step("Compare with baseline", "Check the thermal trend on the System page: is this a load spike or a new sustained level?"),
    step("Review correlated workloads", "The evidence lists correlated top consumers (and running VM workload, which is never attributed to containers)."),
    isDisk ? null : step("Check sensor evidence", "The Unraid temperature sensors panel shows per-sensor warnings/criticals if the owner configured thresholds."),
  ].filter((entry): entry is RunbookStep => entry !== null);
  runbook.actionIds = ["diagnostic:refresh-incident-evidence"];
  runbook.verification = [
    step("Temperature returns below threshold", "The 5-minute average drops below the warning threshold (the hysteresis hold clears) — recovery is proven when the incident closes itself."),
  ];
  runbook.manualRecovery = [
    "Check physical airflow, fans and ambient temperature.",
    "Reduce load or schedule it; adjust fan curves in the BIOS/HBA tooling yourself.",
  ];
  runbook.escalation = "Escalate when temperatures reach the critical band or keep climbing despite reduced load.";
  return runbook;
}

function resourceRunbook(incident: Incident): Runbook {
  const memory = incident.kind === "memory-pressure";
  const runbook = baseRunbook(
    incident.kind,
    memory
      ? "Host memory usage crossed the warning/critical threshold. OOM risk grows as usage climbs."
      : "Host CPU load is sustained above the threshold (5-minute average, Prometheus-sourced).",
  );
  runbook.diagnosticChecks = [
    step("Identify top consumers", memory
      ? "The Docker page ranks containers by memory; VM memory is shown separately on the VMs page."
      : "The Docker page ranks containers by CPU; VM workload is shown separately on the VMs page."),
    step("Correlate with trends", "The entity history panel shows whether this is a climb or a one-off plateau."),
    REFRESH_EVIDENCE_RUNBOOK_STEP,
  ];
  runbook.actionIds = ["diagnostic:refresh-incident-evidence"];
  runbook.manualRecovery = [
    memory
      ? "Stop or right-size the consuming workload yourself in the Unraid UI; Beacon never stops containers over memory pressure."
      : "Reduce or reschedule the load yourself; Beacon never throttles or stops workloads.",
  ];
  runbook.escalation = "Escalate on OOM kills (memory) or when load stays saturated with idle top consumers.";
  return runbook;
}

function storageRunbook(incident: Incident): Runbook {
  const isArray = incident.kind === "array-state";
  const runbook = baseRunbook(
    incident.kind,
    isArray
      ? "The Unraid array is not in its nominal STARTED state. Shares and services may be unavailable."
      : "A disk reports a failure state (RED fsColor or a non-ok disk state). This is a data-integrity signal.",
  );
  runbook.diagnosticChecks = [
    step("Check the Storage page", "The array/disk state and per-disk detail live there; this incident mirrors it."),
    step("Read the disk evidence", "The incident carries the exact state and fsColor observed."),
  ];
  runbook.actionIds = ["diagnostic:refresh-incident-evidence"];
  runbook.manualRecovery = isArray
    ? ["Start/stop the array and investigate parity state yourself in the Unraid management UI — Beacon never touches the array."]
    : ["Follow Unraid's disk-replacement/rebuild procedure yourself. Beacon takes no storage actions, ever."];
  runbook.escalation = "Data-integrity issues escalate immediately; do not write new data to a degraded array.";
  return runbook;
}

function backlogRunbook(incident: Incident): Runbook {
  const runbook = baseRunbook(
    incident.kind,
    "Unraid itself has unread alert notifications. Beacon surfaces the backlog as informational — the underlying conditions, if real, produce their own Beacon incidents.",
  );
  runbook.diagnosticChecks = [step("Review the Notifications page", "Read and archive the Unraid notifications there.")];
  runbook.actionIds = ["diagnostic:refresh-incident-evidence"];
  runbook.escalation = "Not an emergency by definition (info severity). Escalate only if the underlying conditions recur.";
  return runbook;
}

function flappingRunbook(incident: Incident): Runbook {
  const runbook = baseRunbook(
    incident.kind,
    "The underlying condition cleared and reappeared repeatedly inside the window, so Beacon holds ONE incident open instead of emitting a notification storm. The underlying kind is docker health.",
  );
  runbook.diagnosticChecks = [
    step("Read the toggle history", "The timeline shows each clear/reappear transition in the window."),
    step("Find the instability", "A flapping healthcheck usually means a dependency that comes and goes, or a resource race at startup."),
    REFRESH_EVIDENCE_RUNBOOK_STEP,
  ];
  runbook.actionIds = ["diagnostic:refresh-incident-evidence"];
  runbook.manualRecovery = ["Stabilise the container or its dependency; the incident recovers only after a stable healthy streak."];
  return runbook;
}

/** Capacity runbook (Fase 20) — served for capacity forecast warnings in
 *  the insights UI. Guidance only; Beacon never auto-deletes or moves. */
export const CAPACITY_RUNBOOK: Runbook = {
  scope: "capacity-forecast",
  explanation:
    "A capacity forecast warns that a storage pool is trending toward a threshold. Forecasts are ranges with explicit confidence — not alarmist dates.",
  prerequisites: ["enough metric history for the forecast to be confident"],
  diagnosticChecks: [
    step("Read the forecast window", "The insight shows current usage, growth rate, confidence and the estimated threshold window."),
    step("Review biggest known consumers", "The Docker page ranks containers by disk-adjacent resource usage where the data is reliable."),
  ],
  actionIds: [],
  verification: [step("Growth flattens", "The trend turns flat/falling in the insights panel; the warning clears by confidence, not by wishful thinking.")],
  manualRecovery: [
    "Review and clean up consumers manually.",
    "Plan capacity expansion; the mover/cleanup tools remain yours to run.",
  ],
  escalation: "Escalate when the confidence is high and the threshold window is short.",
};

/** Returns the deterministic runbook for an incident, or null for kinds
 *  that intentionally have none. */
export function runbookForIncident(incident: Incident): Runbook | null {
  switch (incident.kind) {
    case "docker-unhealthy":
      return containerRunbook(incident, "docker-unhealthy");
    case "crash-loop":
      return containerRunbook(incident, "crash-loop");
    case "source-unavailable":
    case "source-degraded":
      return sourceRunbook(incident);
    case "persistence-failure":
      return persistenceRunbook(incident);
    case "update-failed":
      return updateFailureRunbook(incident);
    case "thermal":
    case "disk-thermal":
      return thermalRunbook(incident);
    case "memory-pressure":
    case "cpu-sustained":
      return resourceRunbook(incident);
    case "array-state":
    case "disk-state":
      return storageRunbook(incident);
    case "notification-backlog":
      return backlogRunbook(incident);
    case "flapping":
      return flappingRunbook(incident);
    default:
      return null;
  }
}

/**
 * Canonical actions offered for an incident (Fase 1/4). Deterministic —
 * same incident, same actions. Guarded container actions are offered ONLY
 * where the existing mutation is the logical step:
 * - crash-loop: stop (containment) — never restart;
 * - update-failed: retry via the existing verified update flow;
 * - unhealthy: diagnostics only (Fase 13);
 * - everything else: diagnostics only, manual guidance in the runbook.
 */
export function actionsForIncident(incident: Incident): RemediationAction[] {
  const actions: RemediationAction[] = [];
  const runbook = runbookForIncident(incident);
  const offered = new Set(runbook?.actionIds ?? []);
  offered.add("diagnostic:refresh-incident-evidence");

  for (const id of offered) {
    const type = id.split(":").slice(1).join(":") as RemediationActionType;
    switch (type) {
      case "refresh-incident-evidence":
        actions.push(
          diagnosticAction(type, incident, "Refresh incident evidence", "Re-runs the incident evaluation over the latest cached data and refreshes this incident's evidence. Read-only over Beacon's own state.", DIAGNOSTIC_COOLDOWN_MS),
        );
        break;
      case "re-run-persistence-probe":
        actions.push(
          diagnosticAction(type, incident, "Re-run persistence probe", "Writes and removes a unique temp file in Beacon's data directory to re-prove writability. Touches no state files.", PUSH_COOLDOWN_MS),
        );
        break;
      case "re-check-registry":
        actions.push(
          diagnosticAction(type, incident, "Re-check registry update state", "HEAD-queries the registries for known container images. Never pulls images or touches containers.", PUSH_COOLDOWN_MS),
        );
        break;
      case "re-probe-push-delivery":
        actions.push(
          diagnosticAction(type, incident, "Re-probe Web Push delivery", "Sends a real test notification so the delivery path can be re-classified end-to-end.", PUSH_COOLDOWN_MS),
        );
        break;
      case "docker-stop":
        actions.push(containerAction("docker-stop", incident, "Stop container (confirmed)", "Runs the existing confirmed Docker stop for this container as containment for the crash loop."));
        break;
      case "docker-start":
        actions.push(containerAction("docker-start", incident, "Start container (confirmed)", "Runs the existing confirmed Docker start for this container."));
        break;
      case "verified-update-retry":
        actions.push(updateRetryAction(incident));
        break;
      default:
        break;
    }
  }
  return actions;
}
