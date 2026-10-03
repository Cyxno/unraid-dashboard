import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PromClient, PrometheusError, isFreshSample } from "../src/server/prometheus/client";
import { getContainerMetrics, promqlString, isHighCpu, isHighMemory } from "../src/server/prometheus/containers";
import {
  CADVISOR_DOCKER_SELECTOR,
  CONTAINER_CPU_QUERY,
  CONTAINER_CPU_RATE_WINDOW,
  CONTAINER_MEMORY_LIMIT_QUERY,
  CONTAINER_MEMORY_USED_QUERY,
  MEMORY_TOTAL_QUERY,
  cadvisorFreshnessGuard,
  containerCpuQuery,
  containerMemoryUsedQuery,
} from "../src/server/prometheus/queries";
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
    const samples = await client.instant(CONTAINER_CPU_QUERY());
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

/* cAdvisor container query builders ------------------------------------------ */

describe("cAdvisor container query builders", () => {
  it("selects only real Docker containers (64-hex cgroup ids)", () => {
    // buildkit/buildx pseudo-entries use named cgroups — no hex id.
    assert.equal(CADVISOR_DOCKER_SELECTOR, 'id=~"/docker/[0-9a-f]{64}"');
  });

  it("builds CPU percent with rate, host-core normalization and the freshness guard", () => {
    const query = CONTAINER_CPU_QUERY();
    assert.ok(query.includes(`rate(container_cpu_usage_seconds_total{${CADVISOR_DOCKER_SELECTOR}}[${CONTAINER_CPU_RATE_WINDOW}]`));
    assert.ok(query.includes("/ scalar(machine_cpu_cores)"));
    assert.ok(query.includes(cadvisorFreshnessGuard()));
  });

  it("guards against destroyed-container ghosts via container_last_seen", () => {
    const guard = cadvisorFreshnessGuard();
    assert.ok(guard.startsWith("unless on (id)"));
    assert.ok(guard.includes("container_last_seen"));
    assert.ok(guard.includes("time() - 90"));
    // `unless` (not `and`): ids without a last_seen series must survive.
    assert.ok(!guard.includes(" and "));
  });

  it("keeps memory queries on the id selector with the guard attached", () => {
    assert.ok(CONTAINER_MEMORY_USED_QUERY().startsWith(`container_memory_working_set_bytes{${CADVISOR_DOCKER_SELECTOR}}`));
    assert.ok(CONTAINER_MEMORY_LIMIT_QUERY().startsWith(`container_spec_memory_limit_bytes{${CADVISOR_DOCKER_SELECTOR}}`));
    assert.ok(CONTAINER_MEMORY_USED_QUERY().includes(cadvisorFreshnessGuard()));
  });

  it("anchors per-container queries on the Docker id when one is given", () => {
    const short = containerCpuQuery("2e125c468762");
    assert.ok(short.includes('id=~"/docker/2e125c468762[0-9a-f]*"'));
    assert.ok(short.includes("scalar(machine_cpu_cores)"));
    const full = containerMemoryUsedQuery("2e125c468762abcdef".padEnd(64, "0"));
    assert.ok(full.includes('id=~"/docker/2e125c468762abcdef'));
  });

  it("falls back to the name label for non-id inputs, safely escaped", () => {
    const byName = containerCpuQuery("netdata");
    assert.ok(byName.includes('container_cpu_usage_seconds_total{name="netdata"}'));
    assert.ok(!byName.includes("id=~"));
    const hostile = containerMemoryUsedQuery('evil"} or {x="');
    assert.equal(hostile, 'container_memory_working_set_bytes{name="evil\\"} or {x=\\""}');
  });
});

/* Container limit mapping (cgroup-v2 unlimited = 0) --------------------------- */

function stubContainerClient(rows: {
  cpu: Array<[string, number]>;
  used: Array<[string, number]>;
  limit: Array<[string, number]>;
  hostTotal: number;
}) {
  const respond = (query: string) => {
    const pick = (list: Array<[string, number]>) =>
      list.map(([name, v]) => ({ metric: { name }, value: [Math.floor(Date.now() / 1000), String(v)] as [number, string] }));
    let values: Array<{ metric: Record<string, string>; value: [number, string] }>;
    if (query.startsWith("container_memory_working_set_bytes")) values = pick(rows.used);
    else if (query.startsWith("container_spec_memory_limit_bytes")) values = pick(rows.limit);
    else if (query === MEMORY_TOTAL_QUERY) values = [{ metric: {}, value: [1, String(rows.hostTotal)] }];
    else values = pick(rows.cpu);
    return Promise.resolve(values.map((entry) => ({ metric: entry.metric, v: Number(entry.value[1]) })));
  };
  return {
    instant: (query: string) => respond(query),
  } as unknown as PromClient;
}

describe("container metrics limit mapping", () => {
  const HOST_RAM = 32 * 1024 ** 3;

  async function metricsFor(rows: Parameters<typeof stubContainerClient>[0]) {
    (globalThis as unknown as { __dashboardPromCache?: Map<string, unknown> }).__dashboardPromCache?.clear();
    return await getContainerMetrics(stubContainerClient(rows));
  }

  it("treats cgroup-v2 limit 0 as unlimited (no fake cap, % against host RAM)", async () => {
    const map = await metricsFor({
      cpu: [["web", 1.5]],
      used: [["web", 8 * 1024 ** 3]],
      limit: [["web", 0]],
      hostTotal: HOST_RAM,
    });
    const web = map.get("web")!;
    assert.equal(web.hasMemoryLimit, false);
    assert.equal(web.memoryLimitBytes, null);
    assert.equal(web.memoryPercentOfLimit, null);
    // docker MemPerc semantics: usage/limit, limit falls back to host RAM.
    assert.ok(Math.abs((web.memoryPercentOfHost ?? 0) - 25) < 0.001);
  });

  it("keeps a real cap capped: % of limit, hasMemoryLimit true", async () => {
    const cap = 4 * 1024 ** 3;
    const map = await metricsFor({
      cpu: [["db", 2]],
      used: [["db", 2 * 1024 ** 3]],
      limit: [["db", cap]],
      hostTotal: HOST_RAM,
    });
    const db = map.get("db")!;
    assert.equal(db.hasMemoryLimit, true);
    assert.equal(db.memoryLimitBytes, cap);
    assert.ok(Math.abs((db.memoryPercentOfLimit ?? 0) - 50) < 0.001);
    // MemPerc against the cap, matching docker stats.
    assert.ok(Math.abs((db.memoryPercentOfHost ?? 0) - 50) < 0.001);
  });

  it("yields nulls (never zeros) for containers without samples", async () => {
    const map = await metricsFor({
      cpu: [],
      used: [],
      limit: [],
      hostTotal: HOST_RAM,
    });
    assert.equal(map.size, 0);
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
