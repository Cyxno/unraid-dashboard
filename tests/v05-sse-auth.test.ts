import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  subscribe,
  subscriberCount,
  recentTransitions,
  resetSseStore,
} from "../src/server/events/sampler";
import { checkSameOrigin } from "../src/server/auth/auth";
import { resetEnvCache } from "../src/server/env";

function baseEnv(overrides: Record<string, string> = {}) {
  process.env.UNRAID_URL = "http://127.0.0.1:442";
  process.env.UNRAID_API_KEY = "test-read-key";
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  resetEnvCache();
}

/* SSE sampler ---------------------------------------------------------------- */

describe("SSE sampler", () => {
  beforeEach(() => {
    resetSseStore();
  });

  it("tracks subscribers and cleans up on unsubscribe", () => {
    const unsub1 = subscribe(() => {});
    const unsub2 = subscribe(() => {});
    assert.equal(subscriberCount(), 2);
    unsub1();
    assert.equal(subscriberCount(), 1);
    unsub2();
    assert.equal(subscriberCount(), 0);
  });

  it("fans a published event out to every subscriber", async () => {
    const { dispatchForTest } = await import("../src/server/events/sampler");
    const received: string[] = [];
    const unsubs = [
      subscribe((event) => received.push(`a:${event.event}`)),
      subscribe((event) => {
        received.push(`b:${event.event}`);
        throw new Error("broken subscriber must be isolated");
      }),
      subscribe((event) => received.push(`c:${event.event}`)),
    ];
    dispatchForTest({ event: "snapshot", data: {} });
    assert.deepEqual(received, ["a:snapshot", "b:snapshot", "c:snapshot"]);
    for (const unsub of unsubs) unsub();
    assert.equal(subscriberCount(), 0);
  });

  it("keeps the observed transitions buffer bounded and newest-first", async () => {
    const { recordTransitionForTest } = await import("../src/server/events/sampler");
    for (let index = 0; index < 150; index++) {
      recordTransitionForTest(`c${index}`, "EXITED", "RUNNING");
    }
    const transitions = recentTransitions();
    assert.equal(transitions.length, 100); // MAX_TRANSITIONS
    assert.equal(transitions[0]!.name, "c149"); // newest first
  });
});

/* External origin (proxy hostname) ------------------------------------------- */

describe("same-origin with configured external hostname", () => {
  it("accepts the configured PUBLIC_BASE_URL origin", () => {
    baseEnv({
      PUBLIC_BASE_URL: "https://unraid.example.com",
    });
    const headers = new Headers({
      origin: "https://unraid.example.com",
      host: "192.168.1.2:8090", // internal host differs
    });
    assert.equal(checkSameOrigin(headers, null), null);
  });

  it("still rejects unrelated origins when PUBLIC_BASE_URL is set", () => {
    baseEnv({ PUBLIC_BASE_URL: "https://unraid.example.com" });
    const headers = new Headers({
      origin: "https://evil.example",
      host: "192.168.1.2:8090",
    });
    assert.match(checkSameOrigin(headers, null)!, /Cross-origin/);
  });

  it("accepts same-host requests without PUBLIC_BASE_URL", () => {
    baseEnv({});
    const headers = new Headers({ origin: "http://192.168.1.2:8090", host: "192.168.1.2:8090" });
    assert.equal(checkSameOrigin(headers, null), null);
  });
});
