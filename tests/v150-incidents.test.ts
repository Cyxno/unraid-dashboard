import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";
process.env.AUDIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-incidents-"));

import { applyIncidentCycle, deriveConfidence, deriveHealthFromIncidents, markIncidentNotified, formatDuration } from "../src/server/incidents/engine";
import { classifyFreshness } from "../src/server/incidents/freshness";
import { getAllSourceHealth, getSourceHealth, noteSourceAttempt, resetSourceHealth } from "../src/server/incidents/source-health";
import {
  loadIncidentsState,
  loadIncidentsStateFromDisk,
  pruneIncidents,
  resetIncidentsStateCache,
  saveIncidentsNow,
  type IncidentsState,
} from "../src/server/incidents/store";
import { resetEnvCache } from "../src/server/env";
import { evaluateEvents } from "../src/server/notifications/engine";
import { DEFAULT_PREFERENCES } from "../src/server/notifications/types";
import { redactString, redactValue, redactPushEndpoint } from "../src/server/incidents/redact";
import { buildSupportBundle } from "../src/server/incidents/bundle";
import { getPersistenceHealth, resetPersistenceCheckCache } from "../src/server/incidents/persistence-check";
import { parseRestartingStatus, type IncidentObservation } from "../src/server/incidents/observe";
import {
  allHealthy,
  cadvisorStale,
  container,
  crashLoop,
  diskHigh,
  dockerUnhealthy,
  freshState,
  helperDegraded,
  highTemp,
  NOW,
  persistenceFailure,
  prometheusDown,
  recovered,
  stoppedContainers,
  unraidApiDown,
} from "./incident-fixtures";
import type { Incident } from "../src/lib/api-types";

/**
 * v1.5.0 Fase 32 — critical regression suite for the incident
 * intelligence model. One assertion cluster per acceptance criterion;
 * scenarios come from incident-fixtures.ts (Fase 31).
 */

function cycle(observation: IncidentObservation, state: IncidentsState) {
  return applyIncidentCycle({ observation, state });
}

function activeOf(state: IncidentsState): Incident[] {
  return Object.values(state.incidents).filter((incident) => incident.status === "active");
}

describe("v1.5.0 incidents: canonical freshness (Fase 3)", () => {
  test("5s-poll source goes stale after 60s; 15m SMART source only after 90m", () => {
    assert.equal(classifyFreshness(4_000, 5_000), "fresh");
    assert.equal(classifyFreshness(25_000, 5_000), "aging");
    assert.equal(classifyFreshness(61_000, 5_000), "stale");
    assert.equal(classifyFreshness(20 * 60_000, 900_000), "fresh");
    assert.equal(classifyFreshness(80 * 60_000, 900_000), "aging"); // 80m < 90m band
    assert.equal(classifyFreshness(120 * 60_000, 900_000), "stale");
  });

  test("unknown inputs classify as unknown, never as fresh", () => {
    assert.equal(classifyFreshness(null, 5_000), "unknown");
    assert.equal(classifyFreshness(1_000, null), "fresh");
    assert.equal(classifyFreshness(500_000, null), "stale");
  });
});

describe("v1.5.0 incidents: source health contract (Fase 2/8)", () => {
  test("a source never observed is unavailable, not healthy", () => {
    resetSourceHealth();
    const health = getSourceHealth({ source: "prometheus" });
    assert.equal(health.status, "unavailable");
    assert.equal(health.lastSuccessAt, null);
  });

  test("a source whose last success is too old reads stale without any explicit failure", () => {
    resetSourceHealth();
    noteSourceAttempt("prometheus", { ok: true, at: Date.now() - 10 * 60_000 });
    const health = getSourceHealth({ source: "prometheus" });
    assert.equal(health.status, "stale");
    assert.equal(health.freshness, "stale");
  });

  test("failure with last-known-good reads degraded; without, unavailable", () => {
    resetSourceHealth();
    noteSourceAttempt("unraid-api", { ok: true, at: Date.now() - 3_000 });
    noteSourceAttempt("unraid-api", { ok: false, at: Date.now(), safeError: "connection refused" });
    assert.equal(getSourceHealth({ source: "unraid-api" }).status, "degraded");

    resetSourceHealth();
    noteSourceAttempt("unraid-api", { ok: false, at: Date.now(), safeError: "connection refused" });
    assert.equal(getSourceHealth({ source: "unraid-api" }).status, "unavailable");
  });

  test("all canonical sources are always present in the diagnostics snapshot", () => {
    resetSourceHealth();
    const sources = getAllSourceHealth();
    assert.deepEqual(
      sources.map((entry) => entry.source).sort(),
      ["beacon-update", "cadvisor", "docker-inventory", "helper", "node-exporter", "persistence", "prometheus", "unraid-api", "web-push"],
    );
  });
});

describe("v1.5.0 incidents: lifecycle and rules (Fase 5/13/14/17)", () => {
  test("1. stopped containers are never incidents", () => {
    const state = freshState();
    const output = cycle(stoppedContainers(), state);
    assert.equal(output.active.length, 0);
    assert.equal(output.health.level, "healthy");
  });

  test("2. update availability is not an incident (separate state)", () => {
    const state = freshState();
    const observation = allHealthy({
      docker: { containers: [container({ updateFailed: false })], running: 1, total: 1 },
    });
    const output = cycle(observation, state);
    assert.equal(output.active.length, 0);
    // The update pipeline stays a separate surface (sources.ts keeps
    // dockerUpdateEvents out of the incident model).
    const sources = fs.readFileSync("src/server/notifications/sources.ts", "utf8");
    assert.match(sources, /docker:updates:/);
  });

  test("3. unhealthy container IS an incident with direct evidence", () => {
    const state = freshState();
    const output = cycle(dockerUnhealthy(), state);
    const incident = output.active.find((entry) => entry.id === "docker:container:plexdb-ro:unhealthy");
    assert.ok(incident);
    assert.equal(incident.severity, "warning"); // escalates only after 15m
    assert.equal(incident.evidence[0]?.evidenceType, "direct");
    assert.equal(incident.evidence[0]?.value, "health=unhealthy");
    assert.equal(incident.actionable, true);
    // Fase 9 explainability: healthcheck detail rides along as evidence.
    assert.ok(incident.evidence.some((entry) => entry.signal === "docker.healthcheck.failingStreak"));
    assert.ok(incident.evidence.some((entry) => entry.signal === "docker.healthcheck.exitCode"));
    assert.ok(incident.evidence.some((entry) => entry.signal === "docker.healthcheck.lastSuccess"));
  });

  test("unhealthy escalates to critical only after the sustained window", () => {
    const state = freshState();
    cycle(dockerUnhealthy(), state);
    const later = structuredClone(state);
    const observation = dockerUnhealthy();
    observation.now = NOW + 16 * 60_000;
    cycle(observation, later);
    const incident = activeOf(later).find((entry) => entry.id === "docker:container:plexdb-ro:unhealthy");
    assert.equal(incident?.severity, "critical");
    assert.ok(incident?.timeline.some((event) => event.event.includes("escalated")));
  });

  test("4. stale data never reads healthy (evidence carries freshness)", () => {
    const observation = cadvisorStale();
    const state = freshState();
    const output = cycle(observation, state);
    const cadvisor = observation.sources.find((entry) => entry.source === "cadvisor");
    assert.equal(cadvisor?.status, "stale");
    // The stale source shows up as degraded metrics confidence (Fase 24),
    // never as a green dashboard pretending freshness.
    assert.equal(output.confidence.level, "degraded");
    assert.ok(output.confidence.reasons.some((reason) => reason.includes("Metrics confidence")));
  });

  test("5. missing data is UNKNOWN, never a zero-problem", () => {
    const state = freshState();
    const observation = unraidApiDown();
    const output = cycle(observation, state);
    const perEntity = output.active.filter((incident) => incident.id.startsWith("docker:container:"));
    assert.equal(perEntity.length, 0);
    assert.equal(output.health.level, "critical"); // root source incident
  });

  test("6. Prometheus down produces ONE root incident with impact", () => {
    const state = freshState();
    const output = cycle(prometheusDown(), state);
    const sourceIncidents = output.active.filter((incident) => incident.kind === "source-unavailable" || incident.kind === "source-degraded");
    assert.equal(sourceIncidents.length, 1);
    assert.equal(sourceIncidents[0]?.id, "source:prometheus:unavailable");
    assert.equal(sourceIncidents[0]?.severity, "critical");
    assert.ok(sourceIncidents[0]?.impact.includes("container runtime metrics unknown"));
  });

  test("7. no 60-container cascade under a Prometheus outage", () => {
    const state = freshState();
    const fleet = Array.from({ length: 60 }, (_, index) => container({ name: `svc-${index}` }));
    const observation = prometheusDown();
    observation.docker = { containers: fleet, running: 60, total: 60 };
    const output = cycle(observation, state);
    assert.equal(output.active.length, 1);
    assert.equal(output.active[0]?.id, "source:prometheus:unavailable");
  });

  test("8. cAdvisor stale is visible and degrades confidence without false alarms", () => {
    const state = freshState();
    const output = cycle(cadvisorStale(), state);
    assert.ok(output.confidence.reasons.some((reason) => reason.includes("Metrics confidence")));
    assert.equal(output.active.filter((incident) => incident.id.includes("cadvisor")).length, 0);
  });

  test("9. helper degraded is one warning incident with inventory impact", () => {
    const state = freshState();
    const output = cycle(helperDegraded(), state);
    const incident = output.active.find((entry) => entry.id === "source:helper:degraded");
    assert.ok(incident);
    assert.equal(incident.severity, "warning");
    assert.ok(incident.impact.some((line) => line.includes("inventory")));
  });

  test("10. Unraid API unavailable is critical and withholds dependent rules", () => {
    const state = freshState();
    const observation = unraidApiDown();
    const output = cycle(observation, state);
    const incident = output.active.find((entry) => entry.id === "source:unraid-api:unavailable");
    assert.ok(incident);
    assert.equal(incident.severity, "critical");
    assert.ok(incident.impact.includes("docker inventory state unavailable"));
  });

  test("11. source recovery closes the incident once with correct duration", () => {
    const state = freshState();
    cycle(prometheusDown(), state);
    const healthyAt = recovered();
    healthyAt.now = NOW + 5 * 60_000;
    const output = cycle(healthyAt, state);
    const recoveredIncident = state.incidents["source:prometheus:unavailable"];
    assert.equal(recoveredIncident?.status, "recovered");
    assert.ok(recoveredIncident?.resolvedAt);
    assert.ok((recoveredIncident?.durationMs ?? 0) >= 5 * 60_000);
    assert.equal(output.recoveredNow.length, 1);

    // A second healthy cycle must NOT recover it again.
    const output3 = cycle(healthyAt, state);
    assert.equal(output3.recoveredNow.length, 0);
  });

  test("12. dependent recovery: after the source returns, nothing lingers", () => {
    const state = freshState();
    cycle(prometheusDown(), state);
    const healthyAt = recovered();
    healthyAt.now = NOW + 5 * 60_000;
    cycle(healthyAt, state);
    assert.equal(activeOf(state).length, 0);
    assert.equal(state.baselinedAt != null, true);
    const confidence = deriveConfidence(recovered().sources, true);
    assert.equal(confidence.level, "full");
  });

  test("13. crash loop: sustained restarting status proves the pattern", () => {
    const state = freshState();
    const output = cycle(crashLoop(), state);
    const incident = output.active.find((entry) => entry.id === "docker:container:flaky:crash-loop");
    assert.ok(incident);
    assert.equal(incident.kind, "crash-loop");
    assert.equal(incident.severity, "warning");
    assert.ok(incident.evidence.some((entry) => entry.evidenceType === "direct"));
  });

  test("14. a manual one-shot restart is NOT a crash loop", () => {
    const state = freshState();
    // One restart event within the window (transition evidence) + now running.
    state.restarts["app"] = [NOW - 60_000];
    const observation = allHealthy({
      docker: { containers: [container({ name: "app", status: "Up 30 seconds" })], running: 1, total: 1 },
      transitions: [{ name: "app", from: "RUNNING", to: "EXITED", at: NOW - 60_000 }],
    });
    const output = cycle(observation, state);
    assert.equal(output.active.filter((incident) => incident.kind === "crash-loop").length, 0);
  });

  test("restart-count delta ≥2 within the window proves a crash loop", () => {
    const state = freshState();
    state.restarts["app"] = [NOW - 120_000, NOW - 30_000];
    const observation = allHealthy();
    const output = cycle(observation, state);
    const incident = output.active.find((entry) => entry.id === "docker:container:app:crash-loop");
    assert.ok(incident);
    assert.ok(incident.evidence.some((entry) => entry.rule === "crash-loop.frequency"));
  });

  test("parseRestartingStatus extracts exit code and age", () => {
    assert.deepEqual(parseRestartingStatus("Restarting (1) 23 seconds ago"), { exitCode: 1, ageMs: 23_000 });
    assert.deepEqual(parseRestartingStatus("Restarting (7) 2 minutes ago"), { exitCode: 7, ageMs: 120_000 });
    assert.equal(parseRestartingStatus("Up 2 hours (healthy)"), null);
  });

  test("15. flapping holds ONE incident with flapping=true (no push storm)", () => {
    const state = freshState();
    // healthy→unhealthy→healthy→unhealthy→healthy = 2 proven toggles.
    cycle(dockerUnhealthy(), state);
    cycle(recovered(), state); // clear 1 → recovers (single occurrence)
    assert.equal(activeOf(state).length, 0);
    cycle(dockerUnhealthy(), state); // back (same fingerprint, one identity)
    const output = cycle(recovered(), state); // clear 2 → proven flap
    const flapping = Object.values(state.incidents).filter((incident) => incident.flapping);
    assert.equal(flapping.length, 1);
    assert.equal(flapping[0]?.kind, "flapping");
    assert.equal(flapping[0]?.status, "active");
    assert.equal(output.recoveredNow.length, 0); // held, not recovered
    // Exactly one active incident for the entity — no duplicate pairs.
    const entityIncidents = activeOf(state).filter((incident) => incident.entity === "plexdb-ro");
    assert.equal(entityIncidents.length, 1);
    void output;
  });

  test("15b. a flapping incident recovers only after the stable streak", () => {
    const state = freshState();
    cycle(dockerUnhealthy(), state);
    cycle(recovered(), state);
    cycle(dockerUnhealthy(), state);
    cycle(recovered(), state); // now flapping
    // Still-absent cycles keep holding the incident open.
    const holding = cycle(recovered(), state);
    assert.equal(holding.recoveredNow.length, 0);
    // Simulate the stable streak: last matched long ago.
    state.matchedAt["docker:container:plexdb-ro:unhealthy"] = NOW - (10 * 60_000 + 1);
    const done = cycle(recovered(), state);
    assert.equal(done.recoveredNow.length, 1);
    assert.equal(done.recoveredNow[0]?.flapping, false);
  });

  test("16. debounce: one memory spike is not an incident; sustained is", () => {
    const state = freshState();
    const spike = allHealthy({ memoryPercent: 91 });
    cycle(spike, state);
    assert.equal(activeOf(state).length, 0); // anchored, not opened

    const later = structuredClone(state);
    const sustained = allHealthy({ memoryPercent: 91 });
    sustained.now = NOW + 6 * 60_000;
    const output = cycle(sustained, later);
    const incident = output.active.find((entry) => entry.id === "host:memory:warning");
    assert.ok(incident);
    // The anchor made firstSeen truthful: ~6 minutes ago, not "now".
    assert.ok(sustained.now - Date.parse(incident.firstSeenAt) >= 5 * 60_000);
  });

  test("memory ≥95% classifies critical immediately after debounce", () => {
    const state = freshState();
    const high = allHealthy({ memoryPercent: 96 });
    cycle(high, state);
    const later = structuredClone(state);
    const sustained = allHealthy({ memoryPercent: 96 });
    sustained.now = NOW + 6 * 60_000;
    const output = cycle(sustained, later);
    assert.equal(output.active.find((entry) => entry.id === "host:memory:critical")?.severity, "critical");
  });

  test("17. duration accounting: grows while active, exact on recovery", () => {
    const state = freshState();
    cycle(dockerUnhealthy(), state);
    const later = dockerUnhealthy();
    later.now = NOW + 10 * 60_000;
    cycle(later, state);
    let incident = activeOf(state)[0];
    assert.ok(incident);
    assert.ok(Math.abs(incident.durationMs - 10 * 60_000) < 2_000);

    const healedAt = recovered();
    healedAt.now = NOW + 10 * 60_000 + 2_000;
    const done = cycle(healedAt, state);
    incident = state.incidents["docker:container:plexdb-ro:unhealthy"];
    assert.equal(incident?.status, "recovered");
    assert.ok(Math.abs((incident?.durationMs ?? 0) - 10 * 60_000) < 5_000);
    assert.equal(done.recoveredNow.length, 1);
  });

  test("18. thermal evidence reads 'correlated with', never 'caused by'", () => {
    const state = freshState();
    const output = cycle(highTemp(), state);
    const thermal = output.active.find((entry) => entry.id === "host:thermal:package");
    assert.ok(thermal);
    assert.equal(thermal.severity, "warning"); // sustained thermal = warning (Fase 17)
    const correlation = thermal.evidence.find((entry) => entry.signal === "thermal.correlatedWorkloads");
    assert.ok(correlation);
    assert.equal(correlation.evidenceType, "correlated");
    assert.match(correlation.value, /correlated with/);
    assert.doesNotMatch(correlation.value, /caused by/i);
    const serialized = JSON.stringify(output.active);
    assert.doesNotMatch(serialized, /caused by/i);
  });

  test("19. VM workload is never attributed to containers", () => {
    const state = freshState();
    const output = cycle(highTemp(), state);
    const thermal = output.active.find((entry) => entry.id === "host:thermal:package");
    const correlation = thermal?.evidence.find((entry) => entry.signal === "thermal.correlatedWorkloads");
    assert.ok(correlation);
    assert.match(correlation.value, /NOT attributable to containers/);
  });

  test("array/disk rules keep v1.4.x semantics (critical) with direct evidence", () => {
    const state = freshState();
    const stoppedArray = allHealthy({ storage: { state: "STOPPED", parityStatus: null, disks: [] } });
    let output = cycle(stoppedArray, state);
    assert.equal(output.active.find((entry) => entry.kind === "array-state")?.severity, "critical");

    const redDisk = allHealthy({
      storage: { state: "STARTED", parityStatus: null, disks: [{ name: "disk2", state: "DISK_OK", fsColor: "RED", temperatureC: 30 }] },
    });
    const state2 = freshState();
    output = cycle(redDisk, state2);
    const disk = output.active.find((entry) => entry.id === "storage:disk:disk2:critical");
    assert.ok(disk);
    assert.equal(disk.severity, "critical");
    assert.equal(disk.evidence[0]?.evidenceType, "direct");
  });

  test("disk temperature threshold stays a warning incident", () => {
    const state = freshState();
    const output = cycle(diskHigh(), state);
    const disk = output.active.find((entry) => entry.id === "storage:disk:cache:warning");
    assert.ok(disk);
    assert.equal(disk.severity, "warning");
    assert.equal(disk.kind, "disk-thermal");
  });

  test("notification backlog is INFO and never colors health", () => {
    const state = freshState();
    const observation = allHealthy({ notifications: { info: 3, warning: 5, alert: 22 } });
    const output = cycle(observation, state);
    const backlog = output.active.find((entry) => entry.id === "beacon:notifications:backlog");
    assert.ok(backlog);
    assert.equal(backlog.severity, "info");
    assert.equal(backlog.actionable, true);
    assert.equal(output.health.level, "healthy"); // info never escalates
  });

  test("20. Problems count = active incidents (Overview counts)", () => {
    const state = freshState();
    const observation = allHealthy({
      docker: { containers: [container({ name: "a", health: "unhealthy", status: "Up (unhealthy)" })], running: 1, total: 1 },
      notifications: { info: 0, warning: 0, alert: 4 },
    });
    const output = cycle(observation, state);
    assert.equal(output.health.counts?.critical, 0);
    assert.equal(output.health.counts?.warning, 1);
    assert.equal(output.health.counts?.info, 1);
    assert.equal(output.active.length, Object.values(state.incidents).filter((incident) => incident.status === "active").length);
  });

  test("21. notification dedupe: same fingerprint never dispatches twice", () => {
    const state = freshState();
    const first = cycle(dockerUnhealthy(), state);
    const prefs = structuredClone(DEFAULT_PREFERENCES);
    prefs.severities.info = true;
    const decision1 = evaluateEvents(first.events, {}, prefs, NOW);
    assert.ok(decision1.dispatch.some((event) => event.fingerprint === "docker:container:plexdb-ro:unhealthy"));

    const active = { ...decision1.activeUpserts.reduce<Record<string, (typeof decision1.activeUpserts)[number]>>((acc, entry) => { acc[entry.fingerprint] = entry; return acc; }, {}) };
    const second = cycle(dockerUnhealthy(), state);
    const decision2 = evaluateEvents(second.events, active, prefs, NOW + 1_000);
    assert.equal(decision2.dispatch.filter((event) => event.fingerprint === "docker:container:plexdb-ro:unhealthy").length, 0);
  });

  test("22. recovery notification fires exactly once", () => {
    const state = freshState();
    const first = cycle(dockerUnhealthy(), state);
    const prefs = structuredClone(DEFAULT_PREFERENCES);
    prefs.categories.resolved = true;
    prefs.severities.info = true; // resolved events ride the info severity
    const decision1 = evaluateEvents(first.events, {}, prefs, NOW);
    const active: Record<string, (typeof decision1.activeUpserts)[number]> = {};
    for (const entry of decision1.activeUpserts) active[entry.fingerprint] = entry;
    // Orchestrator semantics (notifications/index.ts): a DISPATCHED
    // notification marks notifiedAt on the active entry.
    for (const dispatched of decision1.dispatch) {
      const entry = active[dispatched.fingerprint];
      if (entry) entry.notifiedAt = NOW;
    }

    const healedAt = recovered();
    healedAt.now = NOW + 60_000;
    const second = cycle(healedAt, state);
    const decision2 = evaluateEvents(second.events, active, prefs, NOW + 60_000);
    const resolutions = decision2.dispatch.filter((event) => event.kind === "resolved" && event.fingerprint.includes("plexdb-ro"));
    assert.equal(resolutions.length, 1);

    // Re-running with the ORCHESTRATOR's post-cycle active set (resolved
    // fingerprints deleted, like notifications/index.ts does) must not
    // resolve anything further.
    const active2: Record<string, (typeof decision2.activeUpserts)[number]> = {};
    for (const entry of decision2.activeUpserts) {
      if (!decision2.resolved.includes(entry.fingerprint)) active2[entry.fingerprint] = entry;
    }
    const third = cycle(healedAt, state);
    const decision3 = evaluateEvents(third.events, active2, prefs, NOW + 120_000);
    assert.equal(decision3.dispatch.filter((event) => event.kind === "resolved").length, 0);
  });

  test("markIncidentNotified records only proven delivery facts", () => {
    const state = freshState();
    cycle(dockerUnhealthy(), state);
    markIncidentNotified(state as never, "docker:container:plexdb-ro:unhealthy", { push: "provider-accepted", inApp: "delivered" });
    const incident = state.incidents["docker:container:plexdb-ro:unhealthy"];
    assert.equal(incident?.delivery?.push, "provider-accepted");
    assert.equal(incident?.delivery?.inApp, "delivered");
    assert.ok(incident?.timeline.some((event) => event.event === "notification sent"));
    assert.doesNotMatch(JSON.stringify(incident), /device displayed/i);
  });

  test("23. incidents survive container recreate (persistence)", async () => {
    resetIncidentsStateCache();
    const state = loadIncidentsState();
    cycle(dockerUnhealthy(), state);
    await saveIncidentsNow();

    // Simulate recreate: fresh process, state only from disk.
    resetIncidentsStateCache();
    const reloaded = await loadIncidentsStateFromDisk();
    const incident = reloaded.incidents["docker:container:plexdb-ro:unhealthy"];
    assert.ok(incident);
    assert.equal(incident.status, "active");
    assert.ok(incident.firstSeenAt);
    // Recovered history survives too.
    cycle(recovered(), reloaded);
    await saveIncidentsNow();
    resetIncidentsStateCache();
    const afterRecovery = await loadIncidentsStateFromDisk();
    assert.equal(afterRecovery.incidents["docker:container:plexdb-ro:unhealthy"]?.status, "recovered");
    resetIncidentsStateCache();
  });

  test("recovered history is bounded (no unbounded state growth)", () => {
    const state = freshState();
    for (let index = 0; index < 60; index++) {
      const id = `docker:container:tmp-${index}:unhealthy`;
      state.incidents[id] = {
        id,
        entity: `tmp-${index}`,
        kind: "docker-unhealthy",
        title: `Container unhealthy: tmp-${index}`,
        severity: "warning",
        status: "recovered",
        firstSeenAt: new Date(NOW).toISOString(),
        lastSeenAt: new Date(NOW).toISOString(),
        durationMs: 60_000,
        source: "unraid-api",
        evidence: [],
        rootCauseId: null,
        impact: [],
        notifiedAt: null,
        resolvedAt: new Date(NOW).toISOString(),
        flapping: false,
        actionable: true,
        timeline: [],
        safeCheck: null,
        delivery: null,
      };
    }
    const pruned = pruneIncidents(state.incidents, NOW + 1_000);
    assert.ok(Object.keys(pruned).length <= 50);
  });

  test("persistence failure is a critical incident with durability impact (Fase 25)", () => {
    const state = freshState();
    const output = cycle(persistenceFailure(), state);
    const incident = output.active.find((entry) => entry.id === "beacon:persistence");
    assert.ok(incident);
    assert.equal(incident.severity, "critical");
    assert.equal(incident.kind, "persistence-failure");
    assert.ok(incident.impact.some((line) => line.includes("durability")));
    assert.equal(output.health.level, "critical");
    assert.ok(output.confidence.reasons.some((reason) => reason.includes("durability")));
  });

  test("24. diagnostics source health covers the canonical model", () => {
    const src = fs.readFileSync("src/server/metrics-service.ts", "utf8");
    assert.match(src, /sourceHealth/);
    assert.match(src, /confidence/);
    assert.match(src, /persistence:/);
    const apiTypes = fs.readFileSync("src/lib/api-types.ts", "utf8");
    assert.match(apiTypes, /sourceHealth\?: SourceHealth\[\]/);
  });

  test("25. persistence self-check proves writability and reports failure", async () => {
    resetPersistenceCheckCache();
    const writableDir = fs.mkdtempSync(path.join(os.tmpdir(), "beacon-persist-ok-"));
    process.env.AUDIT_DIR = writableDir;
    resetEnvCache();
    resetPersistenceCheckCache();
    const ok = await getPersistenceHealth();
    assert.equal(ok.dataDirWritable, true);
    assert.equal(ok.failing, false);

    // A path that cannot exist (file used as directory) must read failing.
    const filePath = path.join(writableDir, "not-a-dir");
    fs.writeFileSync(filePath, "x");
    process.env.AUDIT_DIR = path.join(filePath, "data");
    resetEnvCache();
    resetPersistenceCheckCache();
    const broken = await getPersistenceHealth();
    assert.equal(broken.dataDirWritable, false);
    assert.equal(broken.failing, true);
    process.env.AUDIT_DIR = writableDir;
    resetEnvCache();
    resetPersistenceCheckCache();
  });

  test("26. support bundle redacts every secret class", () => {
    const samples = [
      'UNRAID_API_KEY=super-secret-key-value-123456',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig123456789012345678',
      'BEACON_VAPID_PRIVATE_KEY: LS0tLS1CRUdJTiBFQyBQUklWQVRFIEtFWS0tLS0t',
      'https://fcm.googleapis.com/fcm/send/long-endpoint-token-value-123456',
      'p256dh: BCDEF1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      'cookie: session=abcdef0123456789abcdef0123456789',
      'password=hunter2supersecret',
    ];
    for (const sample of samples) {
      const redacted = redactString(sample);
      assert.notEqual(redacted, sample, `expected redaction of: ${sample}`);
      assert.ok(!/super-secret-key-value|hunter2|sig123456789012345678|BCDEF1234567890abcdef|session=abcdef0123456789|LS0tLS1CRUdJTi|long-endpoint-token-value/.test(redacted), `leak in: ${redacted}`);
    }
    const deep = redactValue({ nested: { apiKey: "abcdef123456abcdef123456abcdef123456", note: "safe text about latency" } });
    assert.equal((deep as { nested: { apiKey: string } }).nested.apiKey, "[REDACTED]");
    assert.equal((deep as { nested: { note: string } }).nested.note, "safe text about latency");
    const endpoint = redactPushEndpoint("https://fcm.googleapis.com/fcm/send/token-value-abcdef123456");
    assert.match(endpoint, /^https:\/\/fcm\.googleapis\.com\/…#/);
    assert.doesNotMatch(endpoint, /token-value/);
  });

  test("support bundle shape carries versions, sources, incidents and no secrets", () => {
    resetSourceHealth();
    noteSourceAttempt("unraid-api", { ok: true, at: Date.now() });
    const bundle = buildSupportBundle();
    assert.ok(bundle.version);
    assert.ok(Array.isArray(bundle.sourceHealth));
    assert.ok("activeIncidents" in bundle);
    const serialized = JSON.stringify(bundle);
    for (const forbidden of ["UNRAID_API_KEY", "VAPID_PRIVATE", "p256dh", "Authorization", "password"]) {
      assert.ok(!serialized.includes(forbidden), `bundle must not contain ${forbidden}`);
    }
  });

  test("27. no new polling: the cycle consumes only cached surfaces", () => {
    const observeSrc = fs.readFileSync("src/server/incidents/observe.ts", "utf8");
    // The observation NEVER fetches the overview itself (no recursion, no
    // extra Unraid/Prometheus load) and helper status is 30s-cached.
    assert.doesNotMatch(observeSrc, /getOverview\(/);
    assert.match(observeSrc, /HELPER_STATUS_CACHE_MS = 30_000/);
    assert.match(observeSrc, /peekInventoryLkg\(\)/);
    const cycleSrc = fs.readFileSync("src/server/incidents/cycle.ts", "utf8");
    assert.doesNotMatch(cycleSrc, /fetch\(/);
    assert.match(cycleSrc, /__incidentCycleBusy/); // single-flight guard
    const clientSrc = fs.readFileSync("src/server/prometheus/client.ts", "utf8");
    // Source notes ride EXISTING queries — no extra probing requests.
    assert.doesNotMatch(clientSrc, /setInterval/);
  });
});

describe("v1.5.0 incidents: health derivation & formatting", () => {
  test("deriveHealthFromIncidents maps severity to level", () => {
    const critical: Incident = minimalIncident("critical");
    assert.equal(deriveHealthFromIncidents([critical]).level, "critical");
    assert.equal(deriveHealthFromIncidents([minimalIncident("warning")]).level, "attention");
    assert.equal(deriveHealthFromIncidents([minimalIncident("info")]).level, "healthy");
    assert.equal(deriveHealthFromIncidents([]).level, "healthy");
  });

  test("confidence is blind only when both primary sources are gone", () => {
    assert.equal(deriveConfidence([src("unraid-api", "unavailable"), src("prometheus", "unavailable")], true).level, "blind");
    assert.equal(deriveConfidence([src("unraid-api", "unavailable"), src("prometheus", "healthy")], true).level, "degraded");
    assert.equal(deriveConfidence([src("unraid-api", "healthy"), src("prometheus", "healthy")], true).level, "full");
    // Prometheus unconfigured + everything healthy stays full.
    assert.equal(deriveConfidence([src("unraid-api", "healthy")], false).level, "full");
  });

  test("formatDuration is human and bounded", () => {
    assert.equal(formatDuration(45_000), "45s");
    assert.equal(formatDuration(8 * 60_000), "8m");
    assert.equal(formatDuration(2 * 3_600_000), "2h 0m");
    assert.equal(formatDuration(-5), "—");
  });
});

function src(source: string, status: string) {
  return { source, status };
}

function minimalIncident(severity: Incident["severity"]): Incident {
  return {
    id: "test:incident",
    entity: "test",
    kind: "docker-unhealthy",
    title: "Test incident",
    severity,
    status: "active",
    firstSeenAt: new Date(NOW).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    durationMs: 0,
    source: "unraid-api",
    evidence: [],
    rootCauseId: null,
    impact: [],
    notifiedAt: null,
    resolvedAt: null,
    flapping: false,
    actionable: true,
    timeline: [],
    safeCheck: null,
    delivery: null,
  };
}
