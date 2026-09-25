import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  executeAction,
  ActionError,
  EXPECTED_DOCKER_STATE,
  DOCKER_ACTIONS,
  VM_ACTIONS,
} from "../src/server/actions/action-client";
import { resetEnvCache } from "../src/server/env";

const originalFetch = globalThis.fetch;

/**
 * Mock Unraid:
 * - read key query returns an inventory with one RUNNING and one EXITED container
 * - action key mutations echo a state or fail per scenario
 */
function mockUnraid(options: {
  mutationError?: string;
  mutationStatus?: number;
  mutationState?: string | null;
  networkTimeout?: boolean;
} = {}) {
  (globalThis as unknown as { fetch: (url: string | URL, init?: RequestInit) => Promise<Response> }).fetch =
    async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { query: string };
      const isRead = body.query.includes("containers { id names state }") || body.query.includes("domains");
      if (isRead) {
        return new Response(
          JSON.stringify({
            data: {
              docker: {
                containers: [
                  { id: "running-id:x", names: ["/app-running"], state: "RUNNING" },
                  { id: "stopped-id:x", names: ["/app-stopped"], state: "EXITED" },
                ],
              },
              vms: { domains: [{ id: "vm-1", name: "win11", state: "shut off" }] },
            },
          }),
          { status: 200 },
        );
      }
      if (options.networkTimeout) {
        return new Promise<Response>((_, reject) => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }
      if (options.mutationError) {
        return new Response(
          JSON.stringify({ errors: [{ message: options.mutationError }] }),
          { status: options.mutationStatus ?? 200 },
        );
      }
      const isVm = body.query.includes("vm {");
      if (isVm) {
        return new Response(JSON.stringify({ data: { vm: { start: true, stop: true } } }), { status: 200 });
      }
      const state = options.mutationState ?? "RUNNING";
      return new Response(
        JSON.stringify({ data: { docker: { start: { state }, stop: { state }, restart: { state } } } }),
        { status: 200 },
      );
    };
}

describe("action client (mocked Unraid)", () => {
  beforeEach(() => {
    baseEnv();
  });

  function baseEnv() {
    process.env.UNRAID_URL = "http://127.0.0.1:442";
    process.env.UNRAID_API_KEY = "read-key";
    process.env.UNRAID_ACTION_API_KEY = "action-key";
    resetEnvCache();
  }

  it("starts a stopped container and verifies the resulting state", async () => {
    mockUnraid({ mutationState: "RUNNING" });
    const outcome = await executeAction("docker", "start", "stopped-id:x");
    assert.equal(outcome.status, "success");
    assert.equal(outcome.verified, true);
    assert.equal(outcome.targetName, "app-stopped");
  });

  it("short-circuits start on an already-running container without mutating", async () => {
    mockUnraid();
    const outcome = await executeAction("docker", "start", "running-id:x");
    assert.equal(outcome.status, "already-in-state");
    assert.equal(outcome.verified, true);
  });

  it("stops a running container", async () => {
    mockUnraid({ mutationState: "EXITED" });
    const outcome = await executeAction("docker", "stop", "running-id:x");
    assert.equal(outcome.status, "success");
  });

  it("short-circuits stop on an already-stopped container", async () => {
    mockUnraid();
    const outcome = await executeAction("docker", "stop", "stopped-id:x");
    assert.equal(outcome.status, "already-in-state");
  });

  it("rejects restart — not available on the live API (v4.10.0)", async () => {
    mockUnraid();
    await assert.rejects(
      () => executeAction("docker", "restart", "running-id:x"),
      (error: unknown) =>
        error instanceof ActionError && error.code === "forbidden",
    );
  });

  it("rejects targets absent from the live inventory", async () => {
    mockUnraid();
    const outcome = await executeAction("docker", "start", "not-in-inventory");
    assert.equal(outcome.status, "not-found");
    assert.equal(outcome.verified, false);
  });

  it("surfaces mutation failures as errors", async () => {
    mockUnraid({ mutationError: "driver failure" });
    const outcome = await executeAction("docker", "start", "stopped-id:x");
    assert.equal(outcome.status, "error");
    assert.match(outcome.message, /driver failure/);
  });

  it("maps permission failures to a forbidden error", async () => {
    mockUnraid({ mutationError: "Forbidden resource", mutationStatus: 200 });
    const outcome = await executeAction("docker", "start", "stopped-id:x");
    assert.equal(outcome.status, "error");
    assert.match(outcome.message, /permission/i);
  });

  it("maps not-found mutation responses to not-found", async () => {
    mockUnraid({ mutationError: "(HTTP code 404) no such container - gone" });
    const outcome = await executeAction("docker", "start", "stopped-id:x");
    assert.equal(outcome.status, "not-found");
  });

  it("maps timeouts distinctly", async () => {
    mockUnraid({ networkTimeout: true });
    const outcome = await executeAction("docker", "start", "stopped-id:x");
    assert.equal(outcome.status, "timeout");
  });

  it("handles VM start/stop", async () => {
    mockUnraid();
    const start = await executeAction("vm", "start", "vm-1");
    assert.equal(start.status, "success");
    const stop = await executeAction("vm", "stop", "vm-1");
    assert.equal(stop.status, "success");
  });

  it("treats null VM results as not-found", async () => {
    mockUnraid();
    // Inventory does not contain this domain → refused before mutating.
    const outcome = await executeAction("vm", "start", "unknown-vm");
    assert.equal(outcome.status, "not-found");
  });

  it("never sends non-allowlisted actions", async () => {
    mockUnraid();
    await assert.rejects(
      () => executeAction("docker", "removeContainer", "stopped-id:x"),
      (error: unknown) =>
        error instanceof ActionError && error.code === "forbidden",
    );
    await assert.rejects(
      () => executeAction("vm", "forceStop", "vm-1"),
      (error: unknown) =>
        error instanceof ActionError && error.code === "forbidden",
    );
  });

  it("keeps the allowlists minimal (no destructive operations)", () => {
    assert.deepEqual(DOCKER_ACTIONS, ["start", "stop"]);
    assert.deepEqual(VM_ACTIONS, ["start", "stop"]);
    assert.deepEqual(Object.keys(EXPECTED_DOCKER_STATE), ["start", "stop"]);
  });

  it("reports state mismatches instead of faking success", async () => {
    mockUnraid({ mutationState: "EXITED" }); // expected RUNNING after start
    const outcome = await executeAction("docker", "start", "stopped-id:x");
    assert.equal(outcome.status, "error");
    assert.equal(outcome.verified, false);
    assert.match(outcome.message, /expected RUNNING/);
  });
});
