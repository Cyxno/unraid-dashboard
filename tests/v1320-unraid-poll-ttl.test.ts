import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import { SectionProvider } from "../src/server/unraid/section";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const queries = fs.readFileSync(path.join(ROOT, "src/server/unraid/queries.ts"), "utf8");
const service = fs.readFileSync(path.join(ROOT, "src/server/unraid/service.ts"), "utf8");

/* ---- v1.3.20: standby-friendly polling contract ------------------------- */

describe("v1.3.20: temperature/SMART is decoupled from realtime metrics polling", () => {
  test("METRICS_QUERY no longer requests temperature (SMART collector rides along otherwise)", () => {
    const metricsBlock = queries.slice(
      queries.indexOf("METRICS_QUERY"),
      queries.indexOf("export const TEMPERATURE_QUERY"),
    );
    assert.ok(!/temperature/i.test(metricsBlock), "METRICS_QUERY must not contain temperature");
  });

  test("TEMPERATURE_QUERY exists and resolves the same metrics.temperature shape", () => {
    const block = queries.slice(queries.indexOf("export const TEMPERATURE_QUERY"));
    assert.ok(/query Temperature \{/.test(block));
    assert.ok(/metrics \{/.test(block));
    assert.ok(/temperature \{/.test(block));
    assert.ok(/sensors \{/.test(block));
    assert.ok(/summary \{/.test(block));
  });

  test("temperature has its own SectionProvider with a 15 minute TTL", () => {
    assert.match(service, /const temperatureProvider = new SectionProvider<TemperatureInfo>\(/);
    assert.match(service, /TEMPERATURE_QUERY/);
    assert.match(service, /15 \* 60_000,/);
  });

  test("realtime metrics TTL is 5s and array/storage TTL is 60s", () => {
    assert.match(service, /\n  5_000,/);
    assert.match(service, /\n  60_000,/);
    assert.doesNotMatch(service, /\n  3_000,/);
    assert.doesNotMatch(service, /\n  20_000,/);
  });

  test("temperature consumers read the dedicated provider, not RawMetrics", () => {
    assert.doesNotMatch(service, /temperature: mapTemperature\(payload\)/);
    assert.match(service, /temperatureSection\.data\?\.criticalCount/);
    assert.match(service, /temperature: tempSection\.data \?\? null/);
  });
});

/* ---- in-flight dedupe + TTL cache behaviour (SectionProvider) ------------ */

describe("v1.3.20: SectionProvider keeps in-flight dedupe and TTL caching", () => {
  test("concurrent get() calls share one fetch (in-flight dedupe)", async () => {
    let calls = 0;
    const provider = new SectionProvider<number>(
      "dedupe",
      async () => {
        calls += 1;
        await new Promise((r) => setTimeout(r, 50));
        return calls;
      },
      10_000,
    );
    const results = await Promise.all([provider.get(), provider.get(), provider.get(), provider.get()]);
    assert.equal(calls, 1, "overlapping polls must coalesce into one upstream fetch");
    for (const r of results) assert.equal(r.data, 1);
  });

  test("a fetch failure serves stale data instead of waking upstream again", async () => {
    let calls = 0;
    const provider = new SectionProvider<string>(
      "stale",
      async () => {
        calls += 1;
        if (calls === 1) return "good";
        throw new Error("upstream down");
      },
      30,
    );
    const first = await provider.get();
    assert.equal(first.status, "live");
    await new Promise((r) => setTimeout(r, 40));
    const second = await provider.get();
    assert.equal(second.status, "stale");
    assert.equal(second.data, "good");
  });

  test("cache expiry refetches after the TTL window", async () => {
    let calls = 0;
    const provider = new SectionProvider<number>(
      "ttl",
      async () => {
        calls += 1;
        return calls;
      },
      30,
    );
    await provider.get();
    await new Promise((r) => setTimeout(r, 40));
    const second = await provider.get();
    assert.equal(calls, 2, "TTL expiry must allow exactly one refetch");
    assert.equal(second.data, 2);
  });
});
