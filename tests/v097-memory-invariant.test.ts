import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

/* Memory semantics (v0.9.7): one canonical model — used = total − available
 * (Linux canonical), usedPercent derived from that pair — so
 * usedBytes / totalBytes ≈ percentTotal holds everywhere it is displayed.
 * The invariant below is the acceptance test for the contradiction fixed
 * this release (78% displayed beside "60 of 62 GiB used"). */

const EPSILON = 0.5; // percent points

function invariantHolds(usedBytes: number, totalBytes: number, percentTotal: number): boolean {
  if (totalBytes <= 0) return percentTotal === 0;
  return Math.abs((usedBytes / totalBytes) * 100 - percentTotal) < EPSILON;
}

describe("v0.9.7 memory consistency invariant", () => {
  it("mapMemory derives used/available/percent canonically when available is present", async () => {
    const { mapMemory } = await import("../src/server/unraid/mappers");
    // The real production shape that used to contradict (Unraid values).
    const result = mapMemory({
      metrics: {
        memory: {
          total: 66_971_209_728,
          used: 64_467_771_392, // cache-inclusive MemTotal−MemFree
          available: 15_185_854_464,
          percentTotal: 77.32, // upstream percent — must NOT be trusted
        },
      },
    });
    assert.equal(result.usedBytes, 66_971_209_728 - 15_185_854_464);
    assert.equal(result.availableBytes, 15_185_854_464);
    assert.ok(
      invariantHolds(result.usedBytes, result.totalBytes, result.percentTotal),
      `invariant violated: ${result.usedBytes}/${result.totalBytes} = ${((result.usedBytes / result.totalBytes) * 100).toFixed(1)}% but percentTotal=${result.percentTotal}`,
    );
  });

  it("mapMemory falls back to used/total derivation when available is missing", async () => {
    const { mapMemory } = await import("../src/server/unraid/mappers");
    const result = mapMemory({ metrics: { memory: { total: 1000, used: 250 } } });
    assert.equal(result.percentTotal, 25);
    assert.equal(result.availableBytes, null);
    assert.ok(invariantHolds(result.usedBytes, result.totalBytes, result.percentTotal));
  });

  it("mapMemory never trusts an upstream percent that contradicts used/total", async () => {
    const { mapMemory } = await import("../src/server/unraid/mappers");
    const result = mapMemory({ metrics: { memory: { total: 1000, used: 250, percentTotal: 96 } } });
    assert.equal(result.percentTotal, 25, "upstream percent must be replaced by the derived value");
  });

  it("demo data satisfies the invariant", async () => {
    const { mockOverview } = await import("../src/server/unraid/mock");
    // DemoData carries the memory value directly (no Section wrapper).
    const memory = mockOverview().memory;
    assert.ok(invariantHolds(memory.usedBytes, memory.totalBytes, memory.percentTotal));
  });

  it("service metrics provider canonicalizes at the single collection point", () => {
    const service = read("src/server/unraid/service.ts");
    assert.match(service, /memoryAvailableBytes/);
    assert.match(service, /totalBytes - availableBytes|total - available/);
    assert.match(service, /usedBytes \/ totalBytes\) \* 100000\) \/ 1000/);
    // The upstream percent must no longer flow through untouched.
    assert.doesNotMatch(service, /memoryPercent: \(payload as any\)\?\.metrics\?\.memory\?\.percentTotal/);
  });

  it("the METRICS_QUERY fetches available", () => {
    const queries = read("src/server/unraid/queries.ts");
    assert.match(queries, /memory \{[\s\S]*?available[\s\S]*?percentTotal/);
  });

  it("overview memory section and API type expose availableBytes", () => {
    const apiTypes = read("src/lib/api-types.ts");
    assert.match(apiTypes, /availableBytes: number \| null/);
    const overview = read("src/app/page.tsx");
    assert.match(overview, /availableBytes/);
  });

  it("agent summary and system endpoints expose availableBytes", () => {
    const snapshot = read("src/server/agent/snapshot.ts");
    assert.match(snapshot, /availableBytes: overviewData\?\.memory\.data\?\.availableBytes/);
    const systemRoute = read("src/app/api/agent/v1/system/route.ts");
    assert.match(systemRoute, /availableBytes: overview\?\.memory\.data\?\.availableBytes/);
  });
});
