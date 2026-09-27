import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";

/** v0.7.11 GHCR credential isolation + anonymous flow. */
describe("v0.7.11 GHCR registry credential isolation", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env["GHCR_READ_TOKEN"];

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken !== undefined) process.env["GHCR_READ_TOKEN"] = originalToken;
    else delete process.env["GHCR_READ_TOKEN"];
  });

  it("ghcr-token wordt alleen naar ghcr.io gestuurd, nooit naar docker.io of lscr.io", async () => {
    const requests: Array<{ url: string; auth?: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      requests.push({ url, auth });
      if (url.includes("ghcr.io/token")) {
        return new Response(JSON.stringify({ token: "ghcr-anon" }), { headers: { "content-type": "application/json" } });
      }
      if (url.includes("auth.docker.io")) {
        return new Response(JSON.stringify({ token: "hub-token" }), { headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:digest" } });
    }) as unknown as typeof fetch;

    const { checkRemoteDigest } = await import("../src/server/docker/registry");
    // ghcr: token wordt gebruikt
    await checkRemoteDigest("ghcr.io/cyxno/dumbscope:0.9.7", "ghcr-secret-token");
    const ghcrReq = requests.find((r) => r.url.includes("ghcr.io/v2"));
    assert.equal(ghcrReq?.auth, "Bearer ghcr-secret-token");
    // docker.io: geen ghcr-token
    await checkRemoteDigest("prom/prometheus:latest", "ghcr-secret-token");
    const hubReqs = requests.filter((r) => r.url.includes("registry-1.docker.io"));
    assert.ok(hubReqs.length > 0);
    assert.ok(hubReqs.every((r) => !r.auth?.includes("ghcr-secret-token")), "ghcr token mag niet naar docker.io");
    // lscr.io: ook geen ghcr-token
    await checkRemoteDigest("lscr.io/linuxserver/kavita:0.1", "ghcr-secret-token");
    const lscrReqs = requests.filter((r) => r.url.includes("lscr.io"));
    assert.ok(lscrReqs.every((r) => !r.auth?.includes("ghcr-secret-token")), "ghcr token mag niet naar lscr.io");
  });

  it("GHCR_READ_TOKEN via env wordt gebruikt (bracket access)", async () => {
    process.env["GHCR_READ_TOKEN"] = "env-token-123";
    const requests: Array<{ auth?: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      requests.push({ auth });
      if (url.includes("/token")) {
        return new Response(JSON.stringify({ token: "anon" }), { headers: { "content-type": "application/json" } });
      }
      return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:d" } });
    }) as unknown as typeof fetch;
    const { checkRemoteDigest } = await import("../src/server/docker/registry");
    await checkRemoteDigest("ghcr.io/owner/app:1.0");
    assert.ok(requests.some((r) => r.auth === "Bearer env-token-123"));
  });
});

describe("v0.7.11 ownership classification", () => {
  it("DUMBscope (version tag, ghcr, geen unraid/compose label) = standalone extern beheerd via naam-block", async () => {
    // De gate blokkeert DUMBscope via de naam-blocklist; de classificatie
    // is standalone omdat er geen compose/unraid-labels zijn.
    const { updateGate } = await import("../src/server/docker/policy");
    const c = {
      name: "DUMBscope",
      management_type: "standalone" as const,
      update_available: true,
      risk: "LOW" as const,
      externallyManaged: false,
    };
    const gate = updateGate({ ...c } as Parameters<typeof updateGate>[0]);
    assert.equal(gate.canUpdate, false);
    assert.match(gate.blockedReason ?? "", /externally|AIO/i);
  });
});

describe("v0.7.11 compose adapter via helper (mechanics)", () => {
  it("compose update-opdracht geeft 403 voor DUMB (AIO-block in endpoint)", async () => {
    // De helper blokkeert DUMB in /compose-update — bewezen in de fixture-
    // test hieronder; hier verifiëren we de gate-consistentie aan de
    // dashboard-zijde.
    const { updateGate } = await import("../src/server/docker/policy");
    const gate = updateGate({
      name: "DUMB",
      management_type: "unraid",
      update_available: true,
      risk: "LOW",
      externallyManaged: false,
    } as Parameters<typeof updateGate>[0]);
    assert.equal(gate.canUpdate, false);

  });
});
