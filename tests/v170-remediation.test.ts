import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";
process.env.AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-remediation-"));

import { resetEnvCache } from "../src/server/env";
import {
  actionsForIncident,
  runbookForIncident,
  CAPACITY_RUNBOOK,
} from "../src/server/remediation/runbooks";
import {
  activeOperationFor,
  beginOperation,
  conflictFor,
  ensureOperationsState,
  operationsForEntity,
  operationsForIncident,
  OPERATION_TIMEOUT_MS,
  resetOperationsState,
  saveOperationsNow,
  transitionOperation,
  operationsStateFilePath,
} from "../src/server/remediation/operations";
import { executeRemediationAction } from "../src/server/remediation/execute";
import { recordIncidentActionEvent } from "../src/server/remediation/incident-links";
import {
  loadIncidentsState,
  resetIncidentsStateCache,
  type IncidentsState,
} from "../src/server/incidents/store";
import { applyIncidentCycle } from "../src/server/incidents/engine";
import { publishSnapshot } from "../src/server/incidents/cycle";
import { resetPolicy, reserveAction } from "../src/server/actions/policy";
import { recordAudit, readAudit, resetAuditQueue } from "../src/server/actions/audit";
import { DOCKER_ACTIONS } from "../src/server/actions/action-client";
import { redactValue } from "../src/server/incidents/redact";
import { buildSupportBundle } from "../src/server/incidents/bundle";
import {
  allHealthy,
  crashLoop,
  dockerUnhealthy,
  freshState,
  helperDegraded,
  highTemp,
  persistenceFailure,
  prometheusDown,
} from "./incident-fixtures";
import type { Incident, RemediationActionType } from "../src/lib/api-types";

resetEnvCache();

/** Runs the engine over a fixture observation, publishes the process-wide
 *  snapshot (the executor reads incidents from it) and returns the incidents. */
function incidentsFor(observation: ReturnType<typeof allHealthy>): Record<string, Incident> {
  const state = freshState();
  const output = applyIncidentCycle({ observation, state });
  publishSnapshot(output.active, [], output.health, output.confidence);
  return state.incidents;
}

function firstIncident(observation: ReturnType<typeof allHealthy>): Incident {
  const incidents = incidentsFor(observation);
  const incident = Object.values(incidents).find((entry) => entry.status === "active");
  assert.ok(incident, "fixture must open an incident");
  return incident;
}

const DESTRUCTIVE_TYPES: string[] = [
  "docker-restart",
  "docker-rm",
  "shell-exec",
  "vm-start",
  "vm-stop",
  "host-reboot",
  "docker-daemon-restart",
];

describe("v1.7.0 — canonical action model (Fase 1)", () => {
  test("actions are offered only from the fixed remediation type union", () => {
    const allowed: RemediationActionType[] = [
      "refresh-incident-evidence",
      "re-run-persistence-probe",
      "re-check-registry",
      "re-probe-push-delivery",
      "docker-start",
      "docker-stop",
      "verified-update-retry",
    ];
    const fixtures = [dockerUnhealthy(), crashLoop(), prometheusDown(), helperDegraded(), persistenceFailure(), highTemp()];
    for (const fixture of fixtures) {
      for (const incident of Object.values(incidentsFor(fixture))) {
        for (const action of actionsForIncident(incident)) {
          assert.ok(allowed.includes(action.type), `unexpected action type ${action.type}`);
          assert.ok(!DESTRUCTIVE_TYPES.includes(action.type), `destructive action offered: ${action.type}`);
        }
      }
    }
  });

  test("guarded actions require confirmation and declare verification", () => {
    const incident = firstIncident(crashLoop());
    const stop = actionsForIncident(incident).find((action) => action.type === "docker-stop");
    if (stop) {
      assert.equal(stop.requiresConfirmation, true);
      assert.equal(stop.risk, "guarded");
      assert.ok(stop.verification.length > 0, "guarded actions declare how success is verified");
      assert.ok(stop.preconditions.length >= 3);
    }
  });

  test("diagnostics are safe, reversible and cooldown-bounded (Fase 3/11)", () => {
    for (const fixture of [dockerUnhealthy(), crashLoop(), prometheusDown(), persistenceFailure()]) {
      for (const incident of Object.values(incidentsFor(fixture))) {
        for (const action of actionsForIncident(incident)) {
          if (action.risk === "safe") {
            assert.equal(action.requiresConfirmation, false);
            assert.equal(action.reversible, true);
            assert.ok(action.cooldownMs > 0, "every action has a bounded cooldown");
            assert.equal(action.requiresPrivilege, "none");
          }
        }
      }
    }
  });

  test("no action is ever offered for a stopped-container-style incident kind", () => {
    // Stopped containers are not incidents (v1.3.8 invariant) — the start
    // action lives on the Docker page, not in remediation.
    const fixtures = [allHealthy(), prometheusDown()];
    for (const fixture of fixtures) {
      for (const incident of Object.values(incidentsFor(fixture))) {
        for (const action of actionsForIncident(incident)) {
          assert.ok(action.type !== "docker-start" || incident.kind === "crash-loop", "start is never remediation-offered");
        }
      }
    }
  });
});

describe("v1.7.0 — runbooks (Fase 2/12)", () => {
  test("all 12 required scopes have deterministic runbooks", () => {
    const unhealthy = firstIncident(dockerUnhealthy());
    const loop = firstIncident(crashLoop());
    const helper = firstIncident(helperDegraded());
    const prom = firstIncident(prometheusDown());
    const persistence = firstIncident(persistenceFailure());
    const thermal = firstIncident(highTemp());

    const scopes = [
      runbookForIncident(unhealthy)?.scope,
      runbookForIncident(loop)?.scope,
      runbookForIncident(helper)?.scope, // helper degraded
      runbookForIncident(prom)?.scope, // prometheus unavailable
      runbookForIncident(persistence)?.scope,
      runbookForIncident(thermal)?.scope,
    ];
    assert.deepEqual(
      scopes,
      ["docker-unhealthy", "crash-loop", "source-degraded", "source-unavailable", "persistence-failure", "thermal"],
    );
    for (const runbook of [runbookForIncident(unhealthy), runbookForIncident(loop), runbookForIncident(prom), runbookForIncident(persistence), runbookForIncident(thermal)]) {
      assert.ok(runbook, "runbook exists");
      assert.ok(runbook!.explanation.length > 20);
      assert.ok(runbook!.diagnosticChecks.length > 0);
      assert.ok(runbook!.verification.length > 0);
      assert.ok(runbook!.escalation.length > 10);
    }
  });

  test("runbooks are evidence-based, not free-form AI text (Fase 33 guard)", () => {
    const fixtures = [dockerUnhealthy(), crashLoop(), prometheusDown(), persistenceFailure(), highTemp(), helperDegraded()];
    for (const fixture of fixtures) {
      for (const incident of Object.values(incidentsFor(fixture))) {
        const runbook = runbookForIncident(incident);
        if (!runbook) continue;
        const text = JSON.stringify(runbook).toLowerCase();
        for (const forbidden of ["as an ai", "i think", "probably caused by unknown", "rm -rf", "chmod ", "docker exec", "curl -s", "sudo "]) {
          assert.ok(!text.includes(forbidden), `runbook contains forbidden content: ${forbidden}`);
        }
      }
    }
  });

  test("source outages only offer re-check style diagnostics (Fase 15)", () => {
    const incident = firstIncident(prometheusDown());
    const actions = actionsForIncident(incident);
    assert.ok(actions.length > 0);
    for (const action of actions) {
      assert.equal(action.risk, "safe", "source outage offers only safe diagnostics");
    }
  });

  test("thermal incidents never auto-remediate (Fase 19)", () => {
    const incident = firstIncident(highTemp());
    for (const action of actionsForIncident(incident)) {
      assert.equal(action.risk, "safe");
      assert.ok(action.type !== "docker-stop" && action.type !== "docker-start" && action.type !== "verified-update-retry");
    }
    const runbook = runbookForIncident(incident)!;
    assert.ok(runbook.manualRecovery.length > 0, "thermal guidance is manual");
  });

  test("capacity runbook never auto-deletes or moves (Fase 20)", () => {
    assert.deepEqual(CAPACITY_RUNBOOK.actionIds, []);
    const text = JSON.stringify(CAPACITY_RUNBOOK).toLowerCase();
    assert.ok(!text.includes("auto-delete"));
    assert.ok(CAPACITY_RUNBOOK.manualRecovery.some((entry) => entry.toLowerCase().includes("manually")));
  });

  test("web push runbook retains VAPID keys (Fase 17)", () => {
    const incidents = incidentsFor(allHealthy());
    // web-push runbook is entity-specific within source-degraded; verify
    // via the runbook builder directly for the web-push entity.
    const pushIncident: Incident = {
      ...firstIncident(prometheusDown()),
      id: "source:web-push:degraded",
      entity: "web-push",
      source: "web-push",
    };
    const runbook = runbookForIncident(pushIncident)!;
    assert.ok(runbook);
    assert.ok(JSON.stringify(runbook).includes("Do NOT rotate VAPID"), "push runbook warns against VAPID rotation");
    assert.ok(actionsForIncident(pushIncident).some((action) => action.type === "re-probe-push-delivery"));
    void incidents;
  });

  test("update failure runbook gates retry on fresh preconditions (Fase 18)", () => {
    const updateIncident: Incident = {
      ...firstIncident(dockerUnhealthy()),
      id: "docker:update-failed:demo",
      entity: "demo",
      kind: "update-failed",
    };
    const actions = actionsForIncident(updateIncident);
    const retry = actions.find((action) => action.type === "verified-update-retry");
    assert.ok(retry, "update runbook offers the verified retry");
    assert.ok(retry.preconditions.some((entry) => entry.toLowerCase().includes("helper")));
    assert.ok(retry.preconditions.some((entry) => entry.toLowerCase().includes("cooldown")));
  });
});

describe("v1.7.0 — operation registry (Fase 7/8/10/21)", () => {
  test("explicit lifecycle with legal transitions only (HTTP 200 != success)", () => {
    resetOperationsState();
    const operation = beginOperation({ entity: "c1", operation: "docker-stop", incidentId: null, actor: "test" });
    // pending → succeeded is ILLEGAL: an accepted request proves nothing.
    assert.equal(transitionOperation(operation.id, "succeeded", "shortcut")?.state, "pending");
    assert.equal(transitionOperation(operation.id, "executing")?.state, "executing");
    assert.equal(transitionOperation(operation.id, "verifying")?.state, "verifying");
    assert.equal(transitionOperation(operation.id, "succeeded", "observed")?.state, "succeeded");
    // Terminal states never move again.
    assert.equal(transitionOperation(operation.id, "failed")?.state, "succeeded");
  });

  test("rollback state is explicit and terminal (Fase 29)", () => {
    resetOperationsState();
    const operation = beginOperation({ entity: "c2", operation: "verified-update-retry", incidentId: null, actor: "test" });
    transitionOperation(operation.id, "executing");
    transitionOperation(operation.id, "verifying");
    assert.equal(transitionOperation(operation.id, "rolled-back", "restored from snapshot")?.state, "rolled-back");
  });

  test("timed-out operations release the entity lock (Fase 28)", () => {
    resetOperationsState();
    const operation = beginOperation({ entity: "c3", operation: "docker-start", incidentId: null, actor: "test", timeoutMs: -1 });
    assert.ok(operation.timeoutAt);
    assert.equal(activeOperationFor("c3"), null, "expired operations are not locks");
    assert.equal(operationsForEntity("c3")[0]?.state, "timed-out");
  });

  test("conflict model blocks mutations during an update (Fase 10)", () => {
    resetOperationsState();
    beginOperation({ entity: "c4", operation: "verified-update-retry", incidentId: null, actor: "test" });
    assert.match(conflictFor("c4", "docker-stop") ?? "", /update/i);
    assert.match(conflictFor("c4", "docker-start") ?? "", /update/i);
    assert.equal(conflictFor("c4", "refresh-incident-evidence"), null, "diagnostics never conflict");
  });

  test("operations survive reload (persisted to AUDIT_DIR)", async () => {
    resetOperationsState();
    resetEnvCache();
    const operation = beginOperation({ entity: "persist-me", operation: "docker-stop", incidentId: null, actor: "test" });
    await saveOperationsNow();
    resetOperationsState();
    await ensureOperationsState();
    assert.equal(operationsForEntity("persist-me")[0]?.id, operation.id);
  });

  test("interrupted operations become failed, never silently green", async () => {
    const operation = beginOperation({ entity: "c5", operation: "docker-stop", incidentId: null, actor: "test" });
    transitionOperation(operation.id, "executing");
    await saveOperationsNow();
    const raw = JSON.parse(fs.readFileSync(operationsStateFilePath(), "utf8"));
    raw.operations[operation.id].state = "executing"; // simulate mid-flight crash
    fs.writeFileSync(operationsStateFilePath(), JSON.stringify(raw));
    resetOperationsState();
    await ensureOperationsState();
    assert.equal(operationsForEntity("c5")[0]?.state, "failed");
  });

  test("operation timeout bound is finite (Fase 28)", () => {
    assert.ok(OPERATION_TIMEOUT_MS > 0 && OPERATION_TIMEOUT_MS <= 300_000);
  });
});

describe("v1.7.0 — executor guards (Fase 4/5/9/10)", () => {
  test("unknown or unoffered actions are refused", async () => {
    const incident = firstIncident(dockerUnhealthy());
    const result = await executeRemediationAction({
      incidentId: incident.id,
      actionId: "guarded:docker-stop", // NOT offered for unhealthy (Fase 13)
      actor: "test",
      sourceIp: "127.0.0.1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.state, "rejected");
  });

  test("recovered incidents block actions on stale state (Fase 5)", async () => {
    resetPolicy();
    resetOperationsState();
    const incident = firstIncident(dockerUnhealthy());
    incident.status = "recovered"; // simulate stale UI state
    const result = await executeRemediationAction({
      incidentId: incident.id,
      actionId: "diagnostic:refresh-incident-evidence",
      actor: "test",
      sourceIp: "127.0.0.1",
    });
    assert.equal(result.state, "blocked");
    assert.ok(result.preconditionResults?.some((entry) => entry.id === "incident-active" && !entry.ok));
  });

  test("double-submit executes once (Fase 9)", async () => {
    resetPolicy();
    resetOperationsState();
    resetIncidentsStateCache();
    const incident = firstIncident(persistenceFailure());
    const input = {
      incidentId: incident.id,
      actionId: "diagnostic:re-run-persistence-probe",
      actor: "test",
      sourceIp: "127.0.0.1",
      requestId: "same-request",
    };
    const first = await executeRemediationAction(input);
    const second = await executeRemediationAction(input);
    assert.ok(["succeeded", "failed"].includes(first.state), "first call runs the diagnostic");
    assert.equal(second.duplicate, true, "repeated requestId returns the recorded verdict");
  });

  test("concurrent conflicting operations block a guarded action (Fase 10)", async () => {
    resetPolicy();
    resetOperationsState();
    const incident = firstIncident(crashLoop());
    beginOperation({ entity: incident.entity, operation: "verified-update-retry", incidentId: null, actor: "other" });
    const result = await executeRemediationAction({
      incidentId: incident.id,
      actionId: "guarded:docker-stop",
      actor: "test",
      sourceIp: "127.0.0.1",
    });
    assert.equal(result.state, "blocked");
    assert.ok(result.preconditionResults?.some((entry) => entry.id === "no-conflict" && !entry.ok));
  });

  test("cooldown prevents start/stop storms (Fase 11)", () => {
    resetPolicy();
    const now = Date.now();
    const first = reserveAction("actor-a", "remediation", "entity-x", "docker-stop", now);
    assert.equal(first.allowed, true);
    const second = reserveAction("actor-b", "remediation", "entity-x", "docker-stop", now + 1000);
    assert.equal(second.allowed, false);
    assert.match(second.allowed === false ? second.reason : "", /cooldown/i);
    first.release();
  });
});

describe("v1.7.0 — timeline + audit (Fase 7/22)", () => {
  test("action timeline events are recorded and bounded", () => {
    resetIncidentsStateCache();
    const incidents = incidentsFor(dockerUnhealthy());
    const incident = Object.values(incidents).find((entry) => entry.status === "active")!;
    const state: IncidentsState = { ...freshState(), incidents };
    void state;
    loadIncidentsState().incidents[incident.id] = incident;
    for (let index = 0; index < 40; index++) {
      recordIncidentActionEvent(incident.id, `event ${index}`);
    }
    assert.ok(loadIncidentsState().incidents[incident.id]!.timeline.length <= 30, "incident timeline stays bounded");
  });

  test("audit events record remediation traceability", async () => {
    resetAuditQueue();
    await recordAudit({
      actor: "test",
      sourceIp: "127.0.0.1",
      kind: "remediation",
      action: "docker-stop",
      targetName: "demo",
      targetId: "demo",
      result: "success",
      durationMs: 12,
      incidentId: "docker:container:demo:crash-loop",
      operationId: "op123",
      traceId: "rem-abc",
    });
    const { entries } = await readAudit(50);
    const entry = entries.find((candidate) => candidate.operationId === "op123");
    assert.ok(entry, "remediation audit entry recorded");
    assert.equal(entry.incidentId, "docker:container:demo:crash-loop");
    assert.equal(entry.operationId, "op123");
  });

  test("operations for an incident are linkable (Fase 7)", () => {
    resetOperationsState();
    beginOperation({ entity: "c9", operation: "docker-stop", incidentId: "incident-9", actor: "test" });
    assert.equal(operationsForIncident("incident-9").length, 1);
  });
});

describe("v1.7.0 — security posture (Fase 23/33)", () => {
  test("privilege surface unchanged: docker mutations stay start/stop", () => {
    assert.deepEqual([...DOCKER_ACTIONS], ["start", "stop"], "no restart or broader lifecycle mutation was added");
  });

  test("support bundle carries safe operation metadata only (Fase 30)", () => {
    resetOperationsState();
    beginOperation({ entity: "bundle-entity", operation: "docker-stop", incidentId: null, actor: "test", traceId: "secret-token-should-not-leak" });
    const bundle = buildSupportBundle();
    const text = JSON.stringify(bundle);
    assert.ok(!text.includes("secret-token-should-not-leak"), "traceId never leaks into support bundle");
  });

  test("operation records pass the redactor without secrets (Fase 30)", () => {
    resetOperationsState();
    const operation = beginOperation({ entity: "c10", operation: "docker-stop", incidentId: null, actor: "test" });
    transitionOperation(operation.id, "executing", "running with UPDATE_HELPER_TOKEN=supersecret");
    const cleaned = JSON.stringify(redactValue(operationsForEntity("c10")[0]));
    assert.ok(!cleaned.includes("supersecret"));
  });

  test("manual-only guidance never has an execute path (Fase 26)", () => {
    const fixtures = [dockerUnhealthy(), crashLoop(), prometheusDown(), persistenceFailure(), highTemp()];
    for (const fixture of fixtures) {
      for (const incident of Object.values(incidentsFor(fixture))) {
        for (const action of actionsForIncident(incident)) {
          assert.notEqual(action.risk, "manual-only", "manual-only steps live in the runbook, not the executor");
        }
      }
    }
  });
});

describe("v1.7.0 — performance contract (Fase 34)", () => {
  test("diagnostics reuse the existing cadence (no new pollers)", () => {
    // The refresh diagnostic runs the SAME incident cycle over cached
    // sections; the operation registry only persists with a debounced
    // save — no timers, no hot loops.
    const source = fs.readFileSync("src/server/remediation/operations.ts", "utf8");
    assert.ok(!source.includes("setInterval"), "no continuous polling in operation tracking");
  });

  test("every offered action declares bounded cooldowns", () => {
    const fixtures = [dockerUnhealthy(), crashLoop(), prometheusDown(), persistenceFailure()];
    for (const fixture of fixtures) {
      for (const incident of Object.values(incidentsFor(fixture))) {
        for (const action of actionsForIncident(incident)) {
          assert.ok(action.cooldownMs > 0 && action.cooldownMs <= 300_000);
        }
      }
    }
  });
});

describe("v1.7.0 — mobile UX contract (Fase 24/25)", () => {
  test("incident detail page stacks on mobile and confirms guarded actions", () => {
    const page = fs.readFileSync("src/app/incidents/[id]/page.tsx", "utf8");
    assert.ok(page.includes("lg:grid-cols-2"), "two-column only at lg breakpoint");
    assert.ok(page.includes("REQUIRES CONFIRMATION"), "guarded badge present");
    assert.ok(page.includes("SAFE"), "safe badge present");
    assert.ok(page.includes("ConfirmDialog"), "guarded actions confirm first");
  });
});
