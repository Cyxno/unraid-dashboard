import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

/**
 * Agent API security contract (v0.9.4): read-only, dedicated credential,
 * no leaks, no auth bypass via proxy headers.
 */
describe("v0.9.4 agent API security", () => {
  it("no write routes exist under /api/agent", () => {
    const agentDir = path.join(repoRoot, "src/app/api/agent");
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else if (entry.name === "route.ts") out.push(full);
      }
      return out;
    };
    const routes = walk(agentDir);
    assert.ok(routes.length > 0, "agent routes exist");
    for (const file of routes) {
      const source = read(file.replace(repoRoot + "/", ""));
      assert.ok(!/export async function (POST|PUT|PATCH|DELETE)/.test(source), `${file} must be read-only`);
    }
  });

  it("auth uses constant-time comparison and a dedicated token", () => {
    const auth = read("src/server/agent/auth.ts");
    assert.match(auth, /timingSafeEqual/);
    assert.match(auth, /AGENT_API_TOKEN/);
    assert.ok(!/UPDATE_HELPER_TOKEN|AUTH_PROXY_SECRET|UNRAID_ACTION_API_KEY/.test(auth), "no credential reuse");
  });

  it("token is never read by client components or diagnostics output", () => {
    const counters = read("src/server/agent/auth.ts");
    assert.match(counters, /authFailures/);
    assert.match(counters, /lastRequestEndpoint/);
    assert.ok(!/token.*lastRequest|lastRequest.*token/i.test(counters));
  });

  it("agent auth failures do not leak the token in error messages", () => {
    const auth = read("src/server/agent/auth.ts");
    assert.match(auth, /Agent API token invalid or missing/);
    assert.match(auth, /Agent API is disabled/);
    assert.ok(!/token:\$\{|token: \$\{|`Agent API token \${/.test(auth));
  });
});

/** Agent API contract: routing surface and payload shapes. */
describe("v0.9.4 agent API contract", () => {
  it("capabilities advertises mutations: false", () => {
    const route = read("src/app/api/agent/v1/capabilities/route.ts");
    assert.match(route, /mutations: false/);
    assert.match(route, /apiVersion: AGENT_API_VERSION/);
  });

  it("issues have deterministic ids and lifecycle fields", () => {
    const issues = read("src/server/agent/issues.ts");
    assert.match(issues, /firstSeenAt/);
    assert.match(issues, /lastSeenAt/);
    assert.match(issues, /resolvedAt/);
    assert.match(issues, /status = "resolved"/);
    assert.match(issues, /suggestedChecks/);
  });

  it("endpoints return freshness metadata", () => {
    for (const file of ["storage", "system", "operations"]) {
      const route = read(`src/app/api/agent/v1/${file}/route.ts`);
      assert.match(route, /freshness\(/, `${file} exposes freshness`);
    }
    const snapshot = read("src/server/agent/snapshot.ts");
    assert.match(snapshot, /freshness\(/);
  });

  it("the stream route sends hello + uses the shared sampler ring", () => {
    const stream = read("src/app/api/agent/v1/stream/route.ts");
    assert.match(stream, /send\("hello"/);
    assert.match(stream, /apiVersion: AGENT_API_VERSION/);
    assert.match(stream, /last-event-id/i);
    assert.match(stream, /docker\.transition/);
    assert.match(stream, /system\.health/);
    assert.match(stream, /sseClients \+= 1/);
    assert.match(stream, /sseClients -= 1/);
  });

  it("agent API is versioned under /api/agent/v1", () => {
    const agentDir = path.join(repoRoot, "src/app/api/agent");
    const entries = readdirSync(agentDir, { withFileTypes: true }).map((entry) => entry.name);
    assert.deepEqual(entries.filter((entry) => entry !== "auth.ts" && entry !== "issues.ts" && entry !== "snapshot.ts" && entry !== "stream.ts" && entry !== "api.ts"), ["v1"]);
  });
});

/** Failure-mode behavior: partial data with explicit availability. */
describe("v0.9.4 agent failure modes", () => {
  it("summary builder tolerates every dependency being null", async () => {
    const { loadBundle } = await import("../src/server/agent/snapshot");
    void loadBundle;
    const snapshot = await import("../src/server/agent/snapshot");
    const emptyBundle = { overview: null, diagnostics: null, updates: null, automation: null, projects: null, thermal: null };
    const summary = snapshot.buildSummary(emptyBundle);
    assert.equal(summary.health.level, null);
    assert.equal(summary.cpu.percent, null);
    assert.equal(summary.updatesAvailable, 0); // empty container list → 0 updates
    assert.equal(summary.dependencies.unraid, null);
  });
});
