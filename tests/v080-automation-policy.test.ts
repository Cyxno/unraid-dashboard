import assert from "node:assert/strict";
import { describe, it } from "node:test";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import {
  DEFAULT_CONFIG,
  evaluateTarget,
  isInMaintenanceWindow,
  normalizeConfigPatch,
  type AutomationConfig,
  type SchedulerContext,
  type TargetFacts,
} from "../src/server/automation/policy";

const WINDOW_OPEN: AutomationConfig = {
  ...structuredClone(DEFAULT_CONFIG),
  enabled: true,
  paused: false,
  maintenance: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 - 1, timezone: "UTC" },
};

// 2026-09-28 is a Monday; 12:00 UTC is inside a 0-23 window.
const NOW = new Date("2026-09-28T12:00:00Z");

function facts(overrides: Partial<TargetFacts> = {}): TargetFacts {
  return {
    name: "pilot-test-target",
    optIn: true,
    risk: "LOW",
    managementType: "standalone",
    updateStrategy: "registry_recreate",
    healthcheckPresent: true,
    snapshotPresent: true,
    registryVerified: true,
    updateAvailable: true,
    remoteDigest: "sha256:remote",
    digestAgeMs: 72 * 3_600_000,
    manualSuccesses: 5,
    rollbackCount: 0,
    interventionRequired: false,
    cooldownUntil: null,
    pipelineOwned: false,
    externallyManaged: false,
    ...overrides,
  };
}

function context(overrides: Partial<SchedulerContext> = {}): SchedulerContext {
  return {
    now: NOW,
    config: WINDOW_OPEN,
    helperHealthy: true,
    dataDirWritable: true,
    operationActive: false,
    windowOperationsUsed: 0,
    registryDegraded: false,
    queuedCount: 0,
    ...overrides,
  };
}

describe("v0.8.0 maintenance window (fake time)", () => {
  it("open inside hours, closed outside", () => {
    const config: AutomationConfig = { ...WINDOW_OPEN, maintenance: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startHour: 3, endHour: 5, timezone: "UTC" } };
    assert.equal(isInMaintenanceWindow(new Date("2026-09-28T03:00:00Z"), config).inWindow, true);
    assert.equal(isInMaintenanceWindow(new Date("2026-09-28T04:59:00Z"), config).inWindow, true);
    assert.equal(isInMaintenanceWindow(new Date("2026-09-28T05:00:00Z"), config).inWindow, false);
    assert.equal(isInMaintenanceWindow(new Date("2026-09-28T02:59:00Z"), config).inWindow, false);
  });

  it("honors the configured timezone (UTC 23:00 is 01:00 in UTC+2)", () => {
    const config: AutomationConfig = { ...WINDOW_OPEN, maintenance: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startHour: 1, endHour: 2, timezone: "Europe/Amsterdam" } };
    const utc23 = new Date("2026-09-28T23:00:00Z"); // 01:00 Amsterdam (CEST = UTC+2)
    assert.equal(isInMaintenanceWindow(utc23, config).inWindow, true);
    const utc22 = new Date("2026-09-28T22:00:00Z"); // 00:00 Amsterdam
    assert.equal(isInMaintenanceWindow(utc22, config).inWindow, false);
  });

  it("wraps midnight (22–02 window)", () => {
    const config: AutomationConfig = { ...WINDOW_OPEN, maintenance: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startHour: 22, endHour: 2, timezone: "UTC" } };
    assert.equal(isInMaintenanceWindow(new Date("2026-09-28T23:00:00Z"), config).inWindow, true);
    assert.equal(isInMaintenanceWindow(new Date("2026-09-28T01:00:00Z"), config).inWindow, true);
    assert.equal(isInMaintenanceWindow(new Date("2026-09-28T12:00:00Z"), config).inWindow, false);
  });

  it("day filter and disabled window behave", () => {
    const mondayOnly: AutomationConfig = { ...WINDOW_OPEN, maintenance: { enabled: true, days: [1], startHour: 0, endHour: 23, timezone: "UTC" } };
    assert.equal(isInMaintenanceWindow(new Date("2026-09-28T12:00:00Z"), mondayOnly).inWindow, true); // Monday
    assert.equal(isInMaintenanceWindow(new Date("2026-09-29T12:00:00Z"), mondayOnly).inWindow, false); // Tuesday
    const disabled: AutomationConfig = { ...WINDOW_OPEN, maintenance: { ...WINDOW_OPEN.maintenance, enabled: false } };
    assert.equal(isInMaintenanceWindow(NOW, disabled).inWindow, true);
  });
});

describe("v0.8.0 eligibility state machine (no ambiguous status)", () => {
  it("all gates pass → eligible", () => {
    const verdict = evaluateTarget(facts(), context());
    assert.equal(verdict.state, "eligible");
  });

  it("not opted in → blocked (operator intent dominates)", () => {
    const verdict = evaluateTarget(facts({ optIn: false }), context());
    assert.equal(verdict.state, "blocked");
    assert.ok(verdict.reasons.some((reason) => reason.includes("not opted in")));
  });

  it("globally disabled or paused → blocked", () => {
    assert.equal(evaluateTarget(facts(), context({ config: { ...WINDOW_OPEN, enabled: false } })).state, "blocked");
    assert.equal(evaluateTarget(facts(), context({ config: { ...WINDOW_OPEN, paused: true } })).state, "blocked");
  });

  it("young digest → delayed_by_age; old digest → eligible", () => {
    const young = evaluateTarget(facts({ digestAgeMs: 2 * 3_600_000 }), context());
    assert.equal(young.state, "delayed_by_age");
    const old = evaluateTarget(facts({ digestAgeMs: 72 * 3_600_000 }), context());
    assert.equal(old.state, "eligible");
  });

  it("outside window → outside_window (even when otherwise eligible)", () => {
    const verdict = evaluateTarget(facts(), context({
      config: { ...WINDOW_OPEN, maintenance: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startHour: 4, endHour: 5, timezone: "UTC" } },
    }));
    assert.equal(verdict.state, "outside_window");
  });

  it("cooldown active → cooldown; expired → eligible again", () => {
    const active = evaluateTarget(facts({ cooldownUntil: new Date(NOW.getTime() + 3_600_000).toISOString() }), context());
    assert.equal(active.state, "cooldown");
    const expired = evaluateTarget(facts({ cooldownUntil: new Date(NOW.getTime() - 3_600_000).toISOString() }), context());
    assert.equal(expired.state, "eligible");
  });

  it("intervention required dominates (even over cooldown)", () => {
    const verdict = evaluateTarget(facts({
      interventionRequired: true,
      cooldownUntil: new Date(NOW.getTime() + 3_600_000).toISOString(),
    }), context());
    assert.equal(verdict.state, "intervention_required");
  });

  it("risk/management/pipeline/local-build/healthcheck/snapshot/registry gates all block", () => {
    assert.equal(evaluateTarget(facts({ risk: "HIGH" }), context()).state, "blocked");
    assert.equal(evaluateTarget(facts({ managementType: "custom_deploy" }), context()).state, "blocked");
    assert.equal(evaluateTarget(facts({ pipelineOwned: true }), context()).state, "blocked");
    assert.equal(evaluateTarget(facts({ updateStrategy: "local_build" }), context()).state, "blocked");
    assert.equal(evaluateTarget(facts({ healthcheckPresent: false }), context()).state, "blocked");
    assert.equal(evaluateTarget(facts({ snapshotPresent: false }), context()).state, "blocked");
    assert.equal(evaluateTarget(facts({ registryVerified: false }), context()).state, "blocked");
    assert.equal(evaluateTarget(facts({ updateAvailable: false }), context()).state, "blocked");
    assert.equal(evaluateTarget(facts({ rollbackCount: 1 }), context()).state, "blocked");
    assert.equal(evaluateTarget(facts({ manualSuccesses: 2 }), context()).state, "blocked");
  });

  it("infrastructure gates block: helper unhealthy, data dir unwritable, active op, budget spent", () => {
    assert.equal(evaluateTarget(facts(), context({ helperHealthy: false })).state, "blocked");
    assert.equal(evaluateTarget(facts(), context({ dataDirWritable: false })).state, "blocked");
    assert.equal(evaluateTarget(facts(), context({ operationActive: true })).state, "blocked");
    assert.equal(evaluateTarget(facts(), context({ windowOperationsUsed: 2 })).state, "outside_window");
  });
});

describe("v0.8.0 config normalization (browser boundary)", () => {
  it("accepts a valid patch and normalizes days", () => {
    const result = normalizeConfigPatch(
      { enabled: true, maintenance: { days: [6, 0, 6], startHour: 4, endHour: 6, timezone: "Europe/Berlin" } },
      DEFAULT_CONFIG,
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.config.enabled, true);
      assert.deepEqual(result.config.maintenance.days, [0, 6]);
      assert.equal(result.config.maintenance.timezone, "Europe/Berlin");
    }
  });

  it("rejects invalid values (types, bounds, timezone, empty window)", () => {
    assert.equal(normalizeConfigPatch({ enabled: "yes" }, DEFAULT_CONFIG).ok, false);
    assert.equal(normalizeConfigPatch({ minUpdateAgeHours: 999 }, DEFAULT_CONFIG).ok, false);
    assert.equal(normalizeConfigPatch({ maxPerWindow: 0 }, DEFAULT_CONFIG).ok, false);
    assert.equal(normalizeConfigPatch({ cooldownHours: -5 }, DEFAULT_CONFIG).ok, false);
    assert.equal(normalizeConfigPatch({ maintenance: { days: [] } }, DEFAULT_CONFIG).ok, false);
    assert.equal(normalizeConfigPatch({ maintenance: { days: [9] } }, DEFAULT_CONFIG).ok, false);
    assert.equal(normalizeConfigPatch({ maintenance: { startHour: 24 } }, DEFAULT_CONFIG).ok, false);
    assert.equal(normalizeConfigPatch({ maintenance: { timezone: "Mars/Olympus" } }, DEFAULT_CONFIG).ok, false);
    assert.equal(normalizeConfigPatch({ maintenance: { startHour: 4, endHour: 4 } }, DEFAULT_CONFIG).ok, false);
  });

  it("defaults are conservative: disabled, window 03–05 UTC, 48h age, 2 per window, 24h cooldown", () => {
    assert.equal(DEFAULT_CONFIG.enabled, false);
    assert.equal(DEFAULT_CONFIG.paused, false);
    assert.equal(DEFAULT_CONFIG.maintenance.startHour, 3);
    assert.equal(DEFAULT_CONFIG.maintenance.endHour, 5);
    assert.equal(DEFAULT_CONFIG.maintenance.timezone, "UTC");
    assert.equal(DEFAULT_CONFIG.minUpdateAgeHours, 48);
    assert.equal(DEFAULT_CONFIG.maxPerWindow, 2);
    assert.equal(DEFAULT_CONFIG.cooldownHours, 24);
  });
});
