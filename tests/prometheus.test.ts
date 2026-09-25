import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PromClient, PrometheusError, isFreshSample } from "../src/server/prometheus/client";
import { promqlString, isHighCpu, isHighMemory } from "../src/server/prometheus/containers";
import { classifySensor } from "../src/server/prometheus/thermal";
import {
  parseWindow,
  rateWindowSeconds,
  WINDOW_STEP_SECONDS,
  HISTORY_WINDOWS,
} from "../src/server/prometheus/windows";
import { extractComposeProject } from "../src/server/unraid/mappers";

/* Parsing behaviour is exercised through a stubbed fetch. ------------------ */

const originalFetch = globalThis.fetch;

function stubFetch(body: unknown, ok = true, status = 200) {
  const calls: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = (input: string | URL) => {
    calls.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: ok ? status : 500 }),
    );
  };
  return calls;
}

function vectorResult(values: Array<[string, string]>, metric: Record<string, string> = {}) {
  return {
    status: "success",
    data: {
      resultType: "vector",
      result: values.map(([t, v]) => ({ metric, value: [Number(t), v] })),
    },
  };
}

function matrixResult(series: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>) {
  return {
    status: "success",
    data: { resultType: "matrix", result: series },
  };
}

describe("PromClient parsing", () => {
  it("parses instant vectors and keeps metric labels", async () => {
    const client = new PromClient({ url: "http://prom:9090", timeoutMs: 500 });
    stubFetch(vectorResult([["1700000000", "42.5"], ["1700000000", "7"]], { name: "immich" }));
    const samples = await client.instant("docker_stats_cpu_percent");
    assert.equal(samples.length, 2);
    assert.equal(samples[0]!.v, 42.5);
    assert.equal(samples[0]!.metric.name, "immich");
    globalThis.fetch = originalFetch;
  });

  it("maps NaN and +Inf values to null instead of fake numbers", async () => {
    const client = new PromClient({ url: "http://prom:9090", timeoutMs: 500 });
    stubFetch(vectorResult([["1700000000", "NaN"], ["1700000000", "+Inf"], ["1700000000", "-Inf"]]));
    const samples = await client.instant("x");
    assert.deepEqual(samples.map((sample) => sample.v), [null, null, null]);
    globalThis.fetch = originalFetch;
  });

  it("normalizes range queries with nulls preserved (epoch seconds)", async () => {
    const client = new PromClient({ url: "http://prom:9090", timeoutMs: 500 });
    stubFetch(
      matrixResult([
        {
          metric: { device: "sda" },
          values: [[1700000000, "100"], [1700000060, "NaN"], [1700000120, "150"]],
        },
      ]),
    );
    const series = await client.range("disk", 1700000000, 1700000120, 60);
    assert.equal(series.length, 1);
    assert.equal(series[0]!.metric.device, "sda");
    assert.deepEqual(
      series[0]!.points.map((point) => point.v),
      [100, null, 150],
    );
    // The client returns Prometheus epoch seconds; domain modules convert
    // to millisecond HistoryPoints at the DTO boundary.
    assert.equal(series[0]!.points[0]!.t, 1700000000);
    globalThis.fetch = originalFetch;
  });

  it("returns an empty list when Prometheus reports no series", async () => {
    const client = new PromClient({ url: "http://prom:9090", timeoutMs: 500 });
    stubFetch({ status: "success", data: { resultType: "vector", result: [] } });
    const samples = await client.instant("nothing_here");
    assert.deepEqual(samples, []);
    globalThis.fetch = originalFetch;
  });

  it("throws normalized errors for HTTP failures and bad payloads", async () => {
    const client = new PromClient({ url: "http://prom:9090", timeoutMs: 500 });

    stubFetch({ message: "boom" }, false, 503);
    await assert.rejects(
      () => client.instant("x"),
      (error: unknown) =>
        error instanceof PrometheusError && error.kind === "bad-response",
    );

    stubFetch({ status: "error", error: "parse error" });
    await assert.rejects(
      () => client.instant("x"),
      (error: unknown) =>
        error instanceof PrometheusError && error.kind === "bad-response",
    );

    globalThis.fetch = originalFetch;
  });

  it("throws not-configured when no URL is available", () => {
    // Env must parse (Unraid vars present) while PROMETHEUS_URL stays unset.
    process.env.UNRAID_URL = "http://tower.local";
    process.env.UNRAID_API_KEY = "test-key";
    delete process.env.PROMETHEUS_URL;
    assert.throws(
      () => new PromClient({}),
      (error: unknown) =>
        error instanceof PrometheusError && error.kind === "not-configured",
    );
  });

  it("builds safe query URLs with encoded parameters", async () => {
    const client = new PromClient({ url: "http://prom:9090/", timeoutMs: 500 });
    const calls = stubFetch(vectorResult([]));
    await client.instant('up{job="node"}');
    assert.match(calls[0]!, /^http:\/\/prom:9090\/api\/v1\/query\?query=/);
    assert.ok(calls[0]!.includes("up%7Bjob"));
    globalThis.fetch = originalFetch;
  });
});

describe("freshness", () => {
  it("treats samples newer than the stale window as fresh", () => {
    const now = Date.now();
    assert.equal(isFreshSample(now - 10_000, now), true);
    assert.equal(isFreshSample(now - 10 * 60_000, now), false);
  });
});

/* Container join helpers ---------------------------------------------------- */

describe("container metrics join", () => {
  it("escapes container names into exact PromQL string literals", () => {
    assert.equal(promqlString("immich_server"), '"immich_server"');
    assert.equal(promqlString('weird"name\\path'), '"weird\\"name\\\\path"');
  });

  it("flags high CPU from the documented threshold", () => {
    assert.equal(isHighCpu({ cpuPercent: 90, memoryUsedBytes: null, memoryLimitBytes: null, memoryPercentOfLimit: null, hasMemoryLimit: false, memoryPercentOfHost: null, networkRxBytesPerSec: null, networkTxBytesPerSec: null, networkReliable: false }), true);
    assert.equal(isHighCpu({ cpuPercent: 79.9, memoryUsedBytes: null, memoryLimitBytes: null, memoryPercentOfLimit: null, hasMemoryLimit: false, memoryPercentOfHost: null, networkRxBytesPerSec: null, networkTxBytesPerSec: null, networkReliable: false }), false);
    assert.equal(isHighCpu(undefined), false);
  });

  it("flags high memory by absolute bytes or real limit percentage", () => {
    const base = {
      cpuPercent: null,
      memoryUsedBytes: 5 * 1024 ** 3,
      memoryLimitBytes: null,
      memoryPercentOfLimit: null,
      hasMemoryLimit: false,
      memoryPercentOfHost: null, networkRxBytesPerSec: null, networkTxBytesPerSec: null, networkReliable: false,
    };
    // Over the absolute threshold even without a limit.
    assert.equal(isHighMemory(base), true);
    // Under it, without a limit: not high — never a fake % of host RAM.
    assert.equal(isHighMemory({ ...base, memoryUsedBytes: 1 * 1024 ** 3 }), false);
    // Real limit with a high percentage.
    assert.equal(
      isHighMemory({
        ...base,
        memoryUsedBytes: 900 * 1024 ** 3 / 1000,
        memoryLimitBytes: 1024 ** 3,
        memoryPercentOfLimit: 88,
        hasMemoryLimit: true,
      }),
      true,
    );
    assert.equal(isHighMemory(null), false);
    assert.equal(isHighMemory(undefined), false);
  });
});

/* Thermal classification ------------------------------------------------------ */

describe("thermal sensor classification", () => {
  it("classifies coretemp package and core sensors", () => {
    assert.equal(classifySensor("coretemp", "Package id 0"), "package");
    assert.equal(classifySensor("coretemp", "Core 4"), "core");
    assert.equal(classifySensor("platform_coretemp_0", "temp1"), "other");
  });

  it("classifies acpitz as board and nvme as disk", () => {
    assert.equal(classifySensor("acpitz", "temp1"), "board");
    assert.equal(classifySensor("nvme", "Composite"), "disk");
  });

  it("never invents categories for unknown sensors", () => {
    assert.equal(classifySensor("unknown_chip", "mystery"), "other");
  });
});

/* Windows ----------------------------------------------------------------------- */

describe("history windows", () => {
  it("rejects untrusted window input with the fallback", () => {
    assert.equal(parseWindow("6h"), "6h");
    assert.equal(parseWindow("'; DROP TABLE", "1h"), "1h");
    assert.equal(parseWindow(null, "15m"), "15m");
    assert.equal(parseWindow("30m", "15m"), "15m");
  });

  it("keeps range steps within sane point budgets", () => {
    for (const window of HISTORY_WINDOWS) {
      const step = WINDOW_STEP_SECONDS[window];
      const windowSeconds = {
        "5m": 300,
        "15m": 900,
        "1h": 3600,
        "6h": 21600,
        "24h": 86400,
        "7d": 604800,
      }[window];
      const points = windowSeconds / step;
      assert.ok(points >= 20, `${window}: too few points (${points})`);
      assert.ok(points <= 200, `${window}: too many points (${points})`);
    }
  });

  it("uses rate windows of at least 2x the step and >= 60s", () => {
    assert.equal(rateWindowSeconds("5m"), 60);
    assert.equal(rateWindowSeconds("15m"), 60);
    assert.equal(rateWindowSeconds("1h"), 120);
    assert.equal(rateWindowSeconds("7d"), 7200);
  });
});

/* Compose labels ------------------------------------------------------------------ */

describe("compose project extraction", () => {
  it("extracts com.docker.compose.project from the labels JSON", () => {
    assert.equal(
      extractComposeProject({ "com.docker.compose.project": "immich" }),
      "immich",
    );
    assert.equal(extractComposeProject({}), null);
    assert.equal(extractComposeProject(null), null);
    assert.equal(extractComposeProject("garbage"), null);
    assert.equal(extractComposeProject({ "com.docker.compose.project": 42 }), null);
  });
});
