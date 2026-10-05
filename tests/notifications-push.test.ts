import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import path from "node:path";
import { resetEnvCache } from "../src/server/env";

/**
 * Notification push lifecycle: transport outcomes drive the subscription
 * lifecycle — 410 prunes, 5xx retries once, success stamps delivery.
 * VAPID-less installs degrade to "not configured" without throwing.
 */

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()?.();
  delete process.env.BEACON_VAPID_PUBLIC_KEY;
  delete process.env.BEACON_VAPID_PRIVATE_KEY;
  resetEnvCache();
});

function withVapid(): void {
  process.env.BEACON_VAPID_PUBLIC_KEY = "B" + "k".repeat(86);
  process.env.BEACON_VAPID_PRIVATE_KEY = "priv" + "e".repeat(20);
  resetEnvCache();
}

function subscription(endpoint: string) {
  return {
    endpoint,
    keys: { p256dh: "p256dh-key", auth: "auth-key" },
    label: "test",
    createdAt: "2026-10-02T00:00:00.000Z",
    lastSuccessAt: null,
    lastFailureAt: null,
    enabled: true,
  };
}

describe("notification push lifecycle", () => {
  it("is 'not configured' without VAPID keys and never throws", async () => {
    const { pushConfigured, sendToSubscription } = await import("../src/server/notifications/push");
    assert.equal(pushConfigured().configured, false);
    const outcome = await sendToSubscription(subscription("https://push.example/1"), {
      title: "t", body: "b", tag: "x", url: "/", severity: "info",
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.gone, false);
    assert.match(outcome.detail ?? "", /not configured/);
  });

  it("marks 410 Gone for pruning while successful subscriptions pass", async () => {
    withVapid();
    const { sendToSubscription, setPushTransportForTests } = await import("../src/server/notifications/push");
    setPushTransportForTests(async (subscription) => {
      if (subscription.endpoint.includes("stale")) {
        const error = new Error("gone") as Error & { statusCode?: number };
        error.statusCode = 410;
        throw error;
      }
      return { status: 201 };
    });
    restores.push(() => setPushTransportForTests(null));

    const gone = await sendToSubscription(subscription("https://push.example/stale"), {
      title: "t", body: "b", tag: "x", url: "/", severity: "info",
    });
    assert.equal(gone.ok, false);
    assert.equal(gone.gone, true, "410 must mark the subscription for pruning");

    const alive = await sendToSubscription(subscription("https://push.example/live"), {
      title: "t", body: "b", tag: "x", url: "/", severity: "info",
    });
    assert.equal(alive.ok, true);
    assert.equal(alive.gone, false);
  });

  it("retries transient 5xx exactly once and reports retryable failure", async () => {
    withVapid();
    const { sendToSubscription, setPushTransportForTests } = await import("../src/server/notifications/push");
    let calls = 0;
    setPushTransportForTests(async () => {
      calls += 1;
      const error = new Error("boom") as Error & { statusCode?: number };
      error.statusCode = 503;
      throw error;
    });
    restores.push(() => setPushTransportForTests(null));

    const outcome = await sendToSubscription(subscription("https://push.example/flaky"), {
      title: "t", body: "b", tag: "x", url: "/", severity: "info",
    });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.gone, false);
    assert.equal(outcome.retryable, true);
    assert.equal(calls, 2, "transient failures retry exactly once");
  });

  it("payloads are sanitized plain text (no control chars, bounded length)", async () => {
    withVapid();
    const { sendToSubscription, setPushTransportForTests } = await import("../src/server/notifications/push");
    const captured: { payload: { title: string; body: string } | null } = { payload: null };
    setPushTransportForTests(async (_subscription, payload) => {
      captured.payload = JSON.parse(payload) as { title: string; body: string };
      return { status: 200 };
    });
    restores.push(() => setPushTransportForTests(null));

    await sendToSubscription(subscription("https://push.example/sane"), {
      title: `Unhealthy: bad\x07name${"x".repeat(200)}`,
      body: "multi\nline\ttext",
      tag: "docker:container:bad:unhealthy",
      url: "/docker/bad",
      severity: "critical",
    });
    const seenPayload = captured.payload;
    assert.ok(seenPayload);
    assert.ok(seenPayload.title.length <= 90);
    assert.ok(!/[\u0000-\u001f]/.test(seenPayload.title));
    assert.ok(!seenPayload.body.includes("\n"));
  });
});

describe("notification routes security contract", () => {
  it("reads are read-guarded, mutations are write-guarded + rate limited", async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const base = "src/app/api/notifications";
    for (const entry of await readdir(base, { recursive: true })) {
      const file = String(entry);
      if (!file.endsWith("route.ts")) continue;
      const source = await readFile(path.join(base, file), "utf8");
      const isMutation = /export async function (POST|DELETE)/.test(source);
      if (isMutation) {
        assert.match(source, /guardWrite\(request\)/, `${file} mutations must be write-guarded`);
      } else {
        assert.match(source, /guardRead\(request\)/, `${file} reads must be read-guarded`);
      }
    }
    const testRoute = await readFile(path.join(base, "test/route.ts"), "utf8");
    assert.match(testRoute, /checkWriteRate/, "the test-notification surface must be rate limited");
  });
});
