import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

/**
 * Notification engine regression tests: stable-fingerprint dedupe,
 * preference filtering, burst grouping, recovery events and payload
 * sanitization. The engine is pure — all persistence/dispatch is
 * exercised separately.
 */

import { evaluateEvents, sanitizeEvent } from "../src/server/notifications/engine";
import { DEFAULT_PREFERENCES, type NotificationPreferences, type RawEvent } from "../src/server/notifications/types";

function event(overrides: Partial<RawEvent> = {}): RawEvent {
  return {
    fingerprint: "docker:container:plex:unhealthy",
    category: "docker-health",
    severity: "critical",
    title: "Container unhealthy: plex",
    body: "Health check failed.",
    source: "docker",
    url: "/docker/plex",
    occurredAt: 1_000,
    ...overrides,
  };
}

function prefs(overrides: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return {
    ...DEFAULT_PREFERENCES,
    ...overrides,
    severities: { ...DEFAULT_PREFERENCES.severities, ...overrides.severities },
    categories: { ...DEFAULT_PREFERENCES.categories, ...overrides.categories },
  };
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
});

describe("notification engine: dedupe lifecycle", () => {
  it("first warning produces one notification", () => {
    const decision = evaluateEvents([event()], {}, prefs(), 1_000);
    assert.equal(decision.dispatch.length, 1);
    assert.equal(decision.dispatch[0]?.fingerprint, "docker:container:plex:unhealthy");
    assert.equal(decision.records.filter((r) => r.kind === "event").length, 1);
  });

  it("the same warning on the next poll produces no duplicate", () => {
    const previous = evaluateEvents([event()], {}, prefs(), 1_000);
    const active: Record<string, (typeof previous.activeUpserts)[number]> = {};
    for (const upsert of previous.activeUpserts) active[upsert.fingerprint] = upsert;
    const second = evaluateEvents([event()], active, prefs(), 61_000);
    assert.equal(second.dispatch.length, 0);
    assert.equal(second.records.filter((r) => r.kind === "event").length, 0);
  });

  it("resolution clears the active entry and can emit a recovery event once", () => {
    const first = evaluateEvents([event()], {}, prefs({ categories: { ...DEFAULT_PREFERENCES.categories, resolved: true } }), 1_000);
    const active: Record<string, (typeof first.activeUpserts)[number]> = {};
    for (const upsert of first.activeUpserts) active[upsert.fingerprint] = upsert;
    // Simulate "notified": recovery only fires for notified conditions.
    active[event().fingerprint]!.notifiedAt = 2_000;

    const resolved = evaluateEvents([], active, prefs({ categories: { ...DEFAULT_PREFERENCES.categories, resolved: true } }), 3_000);
    assert.equal(resolved.resolved.length, 1);
    assert.ok(resolved.dispatch.some((d) => d.title.includes("Resolved") && d.title.includes("plex")));

    // Recurrence after resolve → a new notification.
    const again = evaluateEvents([event()], {}, prefs(), 4_000);
    assert.equal(again.dispatch.length, 1);
  });

  it("recovery notifications are skipped when resolved events are disabled", () => {
    const enabled = prefs({ categories: { ...DEFAULT_PREFERENCES.categories, resolved: true } });
    const first = evaluateEvents([event()], {}, enabled, 1_000);
    const active: Record<string, (typeof first.activeUpserts)[number]> = {};
    for (const upsert of first.activeUpserts) active[upsert.fingerprint] = upsert;
    active[event().fingerprint]!.notifiedAt = 2_000;
    const disabled = prefs({ categories: { ...DEFAULT_PREFERENCES.categories, resolved: false } });
    const resolved = evaluateEvents([], active, disabled, 3_000);
    assert.equal(resolved.dispatch.filter((d) => d.kind === "resolved").length, 0);
    assert.ok(resolved.records.some((r) => r.delivery === "skipped-preference"));
  });
});

describe("notification engine: preference filters", () => {
  it("critical disabled → skipped with an explicit reason", () => {
    const decision = evaluateEvents(
      [event()],
      {},
      prefs({ severities: { ...DEFAULT_PREFERENCES.severities, critical: false } }),
      1_000,
    );
    assert.equal(decision.dispatch.length, 0);
    assert.ok(decision.records.some((r) => r.delivery === "skipped-preference" && r.detail === "critical severity disabled"));
  });

  it("master off → nothing delivered", () => {
    const decision = evaluateEvents([event()], {}, prefs({ master: false }), 1_000);
    assert.equal(decision.dispatch.length, 0);
    assert.ok(decision.records.every((r) => r.delivery === "skipped-preference"));
  });

  it("category disabled → skipped (docker updates default off)", () => {
    const decision = evaluateEvents(
      [event({ fingerprint: "docker:update:plex", category: "docker-updates", severity: "info", title: "Update available: plex" })],
      {},
      prefs({ severities: { ...DEFAULT_PREFERENCES.severities, info: true } }),
      1_000,
    );
    assert.equal(decision.dispatch.length, 0);
    assert.ok(decision.records.some((r) => r.delivery === "skipped-preference" && (r.detail ?? "").includes("docker-updates")));
  });

  it("info severity disabled by default → skipped; enabled → delivered", () => {
    const info = event({ fingerprint: "docker:updates:plex", category: "docker-updates", severity: "info", title: "x" });
    // docker-updates category is off by default; enable it to isolate severity.
    const categoryOn = prefs({ categories: { ...DEFAULT_PREFERENCES.categories, "docker-updates": true } });
    assert.equal(evaluateEvents([info], {}, categoryOn, 1_000).dispatch.length, 0);
    const severityOn = prefs({ categories: { ...DEFAULT_PREFERENCES.categories, "docker-updates": true }, severities: { ...DEFAULT_PREFERENCES.severities, info: true } });
    assert.equal(evaluateEvents([info], {}, severityOn, 1_000).dispatch.length, 1);
  });
});

describe("notification engine: burst grouping", () => {
  const burst = () =>
    Array.from({ length: 6 }, (_, index) =>
      event({
        fingerprint: `docker:container:app${index}:unhealthy`,
        severity: "warning",
        title: `Container unhealthy: app${index}`,
      }),
    );

  it("groups warning bursts beyond the individual cap into one digest", () => {
    const decision = evaluateEvents(burst(), {}, prefs(), 1_000);
    const individual = decision.dispatch.filter((d) => d.kind === "event");
    const digests = decision.dispatch.filter((d) => d.kind === "digest");
    assert.equal(individual.length, 3);
    assert.equal(digests.length, 1);
    assert.match(digests[0]?.title ?? "", /3 new conditions/);
  });

  it("critical events are never grouped away", () => {
    const criticalBurst = Array.from({ length: 6 }, (_, index) =>
      event({ fingerprint: `docker:container:app${index}:unhealthy`, title: `Container unhealthy: app${index}` }),
    );
    const decision = evaluateEvents(criticalBurst, {}, prefs(), 1_000);
    const individualCritical = decision.dispatch.filter((d) => d.severity === "critical" && d.kind === "event");
    assert.equal(individualCritical.length, 6);
  });
});

describe("notification payload sanitization", () => {
  it("strips control characters and caps length", () => {
    const sanitized = sanitizeEvent(
      event({
        title: `Container unhealthy: bad\x1b[31mname${"x".repeat(200)}`,
        body: "line1\nline2\ttab",
      }),
    );
    assert.ok(!/[\u0000-\u001f]/.test(sanitized.title));
    assert.ok(sanitized.title.length <= 90);
    assert.ok(!sanitized.body.includes("\n"));
  });
});
