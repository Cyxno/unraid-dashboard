import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deriveHealth } from "../src/server/health";
import { MetricsHistory } from "../src/server/history";
import { formatBytes, formatPercent, formatTemp, formatUptime, humanState } from "../src/lib/utils";
import type { HealthInputs } from "../src/server/health";

function section<T>(data: T, status: "live" | "stale" | "unavailable" | "demo" = "live") {
  return { status, data, fetchedAt: new Date().toISOString(), ageMs: 0 };
}

function container(overrides: Partial<import("../src/lib/api-types").DockerContainerSummary> = {}) {
  return {
    id: "1",
    name: "api",
    image: "x",
    state: "RUNNING" as const,
    status: "Up",
    health: null,
    autoStart: true,
    updateAvailable: false,
    iconUrl: null,
    webUiUrl: null,
    createdEpochSeconds: null,
    composeProject: null,
    metrics: null,
    ports: [],
    ...overrides,
  };
}

/** Base inputs: all Prometheus-derived fields null (Prometheus offline). */
function healthInputs(overrides: Partial<HealthInputs> = {}): HealthInputs {
  const baseStorage: import("../src/lib/api-types").StorageUsage = {
    state: "STARTED",
    totalBytes: 1,
    usedBytes: 0,
    freeBytes: 1,
    parityStatus: "COMPLETED",
    parityProgressPercent: null,
    disks: [{ name: "disk1", device: "sdb", role: "data", state: "DISK_OK", fsType: null, sizeBytes: 1, usedBytes: 0, freeBytes: 1, temperatureC: 30, fsColor: "GREEN" }],
  };
  return {
    storage: section(baseStorage),
    docker: section({ running: 0, total: 0, containers: [] }),
    notifications: section({ unreadCounts: { info: 0, warning: 0, alert: 0 }, recent: [] }),
    memoryPercent: 40,
    temperatureCriticalCount: 0,
    cpuPackageC: null,
    cpuPackage5mAvgC: null,
    sustainedCpuPercent: null,
    loadLevel: null,
    prometheusStatus: null,
    ...overrides,
  };
}

describe("deriveHealth", () => {
  it("is healthy when nothing is wrong", () => {
    const health = deriveHealth(healthInputs());
    assert.equal(health.level, "healthy");
    assert.deepEqual(health.reasons, []);
  });

  it("escalates to critical on a stopped array", () => {
    const storage = section({
      state: "STOPPED",
      totalBytes: 1,
      usedBytes: 0,
      freeBytes: 1,
      parityStatus: "COMPLETED",
      parityProgressPercent: null,
      disks: [],
    });
    const health = deriveHealth(healthInputs({ storage }));
    assert.equal(health.level, "critical");
    assert.ok(health.reasons.some((reason) => reason.includes("Array state")));
  });

  it("escalates to critical on a red disk", () => {
    const storage = section({
      state: "STARTED",
      totalBytes: 1,
      usedBytes: 0,
      freeBytes: 1,
      parityStatus: "COMPLETED",
      parityProgressPercent: null,
      disks: [{ name: "disk1", device: "sdb", role: "data" as const, state: "DISK_OK", fsType: null, sizeBytes: 1, usedBytes: 0, freeBytes: 1, temperatureC: 30, fsColor: "RED" }],
    });
    const health = deriveHealth(healthInputs({ storage }));
    assert.equal(health.level, "critical");
  });

  it("treats alert notifications as critical and warnings as attention", () => {
    const critical = deriveHealth(
      healthInputs({
        notifications: section({ unreadCounts: { info: 0, warning: 0, alert: 1 }, recent: [] }),
      }),
    );
    assert.equal(critical.level, "critical");

    const attention = deriveHealth(
      healthInputs({
        notifications: section({ unreadCounts: { info: 0, warning: 2, alert: 0 }, recent: [] }),
      }),
    );
    assert.equal(attention.level, "attention");
  });

  it("flags unhealthy containers and autostart exits", () => {
    const critical = deriveHealth(
      healthInputs({
        docker: section({
          running: 1,
          total: 1,
          containers: [
            container({ health: "unhealthy", status: "Up (unhealthy)" }),
          ],
        }),
      }),
    );
    assert.equal(critical.level, "critical");
    assert.ok(critical.reasons.some((reason) => reason.includes("api")));

    const attention = deriveHealth(
      healthInputs({
        docker: section({
          running: 0,
          total: 1,
          containers: [
            container({ id: "2", name: "worker", state: "EXITED", status: "Exited" }),
          ],
        }),
      }),
    );
    assert.equal(attention.level, "attention");
  });

  it("uses memory pressure thresholds", () => {
    assert.equal(deriveHealth(healthInputs({ memoryPercent: 96 })).level, "critical");
    assert.equal(deriveHealth(healthInputs({ memoryPercent: 91 })).level, "attention");
    assert.equal(deriveHealth(healthInputs({ memoryPercent: 50 })).level, "healthy");
  });

  it("escalates on package temperature pressure (thermal inputs)", () => {
    const attention = deriveHealth(healthInputs({ cpuPackageC: 83 }));
    assert.equal(attention.level, "attention");
    assert.ok(attention.reasons.some((reason) => reason.includes("CPU package")));

    // v0.6 hysteresis: a single critical SAMPLE escalates to attention
    // only; critical requires the sustained (5m) average.
    const singleSpike = deriveHealth(healthInputs({ cpuPackageC: 92 }));
    assert.equal(singleSpike.level, "attention");

    const critical = deriveHealth(
      healthInputs({ cpuPackageC: 92, cpuPackage5mAvgC: 90.5 }),
    );
    assert.equal(critical.level, "critical");

    // Below the documented threshold: healthy.
    assert.equal(deriveHealth(healthInputs({ cpuPackageC: 70 })).level, "healthy");
  });

  it("notes sustained 5-minute CPU pressure, not spikes", () => {
    const health = deriveHealth(healthInputs({ sustainedCpuPercent: 88 }));
    assert.equal(health.level, "attention");
    assert.ok(health.reasons.some((reason) => reason.includes("5 minutes")));

    assert.equal(
      deriveHealth(healthInputs({ sustainedCpuPercent: 50 })).level,
      "healthy",
    );
  });

  it("marks high load relative to threads as attention", () => {
    const health = deriveHealth(healthInputs({ loadLevel: "high" }));
    assert.equal(health.level, "attention");
    // Neutral labels never escalate on their own.
    assert.equal(deriveHealth(healthInputs({ loadLevel: "elevated" })).level, "healthy");
    assert.equal(deriveHealth(healthInputs({ loadLevel: "normal" })).level, "healthy");
  });

  it("flags Prometheus outage as attention, not critical", () => {
    const health = deriveHealth(healthInputs({ prometheusStatus: "unavailable" }));
    assert.equal(health.level, "attention");
    assert.ok(health.reasons.some((reason) => reason.includes("Prometheus unavailable")));
  });

  it("ignores unavailable sections instead of failing", () => {
    const health = deriveHealth(
      healthInputs({
        storage: section(null, "unavailable"),
        docker: section(null, "unavailable"),
        notifications: section(null, "unavailable"),
        memoryPercent: null,
        temperatureCriticalCount: null,
      }),
    );
    assert.equal(health.level, "healthy");
  });
});

describe("MetricsHistory", () => {
  it("records samples with a minimum interval and prunes old data", () => {
    const history = new MetricsHistory();
    const base = Date.now();
    assert.equal(history.record({ cpu: 1, memory: 1, rx: 0, tx: 0 }, base), true);
    // Too soon: rejected
    assert.equal(history.record({ cpu: 2, memory: 2, rx: 0, tx: 0 }, base + 1000), false);
    assert.equal(history.record({ cpu: 2, memory: 2, rx: 0, tx: 0 }, base + 6000), true);
    assert.equal(history.totalSamples, 2);

    // Old samples fall out of the 2h retention window
    history.record({ cpu: 3, memory: 3, rx: 0, tx: 0 }, base + 3 * 60 * 60 * 1000);
    assert.equal(history.totalSamples, 1);
  });

  it("slices by window and downsamples large sets", () => {
    const history = new MetricsHistory();
    const base = Date.now();
    // 61 samples spaced 6s apart = ~6 minutes
    for (let index = 0; index <= 60; index++) {
      history.record(
        { cpu: index, memory: index, rx: 0, tx: 0 },
        base - (60 - index) * 6000,
      );
    }
    assert.equal(history.totalSamples, 61);
    const fiveMinutes = history.slice("5m", base);
    assert.ok(fiveMinutes.length > 0);
    assert.ok(fiveMinutes.every((sample) => sample.time >= base - 5 * 60_000));
    assert.ok(history.windowFilled("5m", base));
    assert.equal(history.windowFilled("1h", base), false);

    // Force downsampling: build >360 samples within one window
    const dense = new MetricsHistory();
    for (let index = 0; index < 400; index++) {
      dense.record({ cpu: 1, memory: 1, rx: 0, tx: 0 }, base + index * 1000);
    }
    // retention prunes to the last 2h — all 400 fit (400s), so slice 1h
    const sliced = dense.slice("1h", base + 399_000);
    assert.ok(sliced.length <= 360);
    // The sampler records at most one point per 5s, so the newest sample is
    // at or before "now"; downsampling always keeps the newest point.
    assert.ok((sliced.at(-1)?.time ?? 0) <= base + 399_000);
    assert.ok(sliced.every((sample, index) => index === 0 || sample.time >= (sliced[index - 1]?.time ?? 0)));
  });
});

describe("formatting utilities", () => {
  it("formats bytes with binary units", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(1536 * 1024 ** 3, 1), "1.5 TB");
    assert.equal(formatBytes(null), "—");
    assert.equal(formatBytes(500, 0), "500 B");
  });

  it("formats percentages without fake precision", () => {
    assert.equal(formatPercent(48.23), "48%");
    assert.equal(formatPercent(5.12), "5.1%");
    assert.equal(formatPercent(null), "—");
    assert.equal(formatPercent(33.3, 1), "33.3%");
  });

  it("formats temperatures in both units", () => {
    assert.equal(formatTemp(68), "68°C");
    assert.equal(formatTemp(68, "F"), "154°F");
    assert.equal(formatTemp(null), "—");
  });

  it("formats uptime compactly", () => {
    assert.equal(formatUptime(41 * 86400 + 3600), "41d 1h");
    assert.equal(formatUptime(3600), "1h 0m");
    assert.equal(formatUptime(300), "5m");
    assert.equal(formatUptime(null), "—");
  });

  it("humanizes state enums", () => {
    assert.equal(humanState("STARTED"), "Started");
    assert.equal(humanState("PARITY_NOT_BIGGEST"), "Parity not biggest");
    assert.equal(humanState(null), "—");
  });
});

describe("hero verdict mapping (v1.1.3 regression)", () => {
  it("maps attention to a verdict and never compares against 'warning'", () => {
    const src = readFileSync("src/components/dashboard/hero-strip.tsx", "utf8");
    assert.match(src, /healthLevel === "attention"/, "attention level must map to a verdict");
    assert.doesNotMatch(src, /healthLevel === "warning"/, "'warning' is not a HealthLevel value");

    // End-to-end with the exact situation that surfaced it.
    const attention = deriveHealth(
      healthInputs({
        docker: section({
          running: 1,
          total: 2,
          containers: [
            container({ name: "watchtower", state: "EXITED" as const }),
            container({ name: "Proxy-WOL-Redirect", state: "EXITED" as const }),
          ],
        }),
      }),
    );
    assert.equal(attention.level, "attention");
    assert.ok(attention.reasons.some((reason) => reason.includes("Autostart container(s) stopped")));
  });
});

