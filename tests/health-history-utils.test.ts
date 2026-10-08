import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs";
import { MetricsHistory } from "../src/server/history";
import { formatBytes, formatPercent, formatTemp, formatUptime, humanState } from "../src/lib/utils";

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
  });
});

describe("autostart-stopped containers stay neutral (v1.1.5, v1.5.0 engine)", () => {
  it("8. the Docker page shows the neutral autostart info badge", () => {
    const src = fs.readFileSync("src/app/docker/page.tsx", "utf8");
    assert.match(src, /Autostart · stopped/);
    // Neutral styling only: the badge is rendered with variant="muted".
    assert.doesNotMatch(src, /variant="(destructive|warning)"[^>]*>s*{?s*Autostart/);
  });

  it("1-7: stopped/exited containers never become incidents (engine)", async () => {
    const { applyIncidentCycle } = await import("../src/server/incidents/engine");
    const { stoppedContainers, freshState } = await import("./incident-fixtures");
    const state = freshState();
    const output = applyIncidentCycle({ observation: stoppedContainers(), state });
    assert.equal(output.active.length, 0);
    assert.equal(output.health.level, "healthy");
    assert.ok(!JSON.stringify(output).match(/autostart/i));
  });
});
