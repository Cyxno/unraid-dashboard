import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAuth,
  checkSameOrigin,
  isPrivateIp,
  ipMatches,
} from "../src/server/auth/auth";
import {
  reserveAction,
  resetPolicy,
  cooldownKey,
} from "../src/server/actions/policy";
import { readAudit, recordAudit, resetAuditQueue } from "../src/server/actions/audit";
import { resetEnvCache } from "../src/server/env";

/** Env is validated with zod — every test needs a parseable base. */
function baseEnv(overrides: Record<string, string> = {}) {
  process.env.UNRAID_URL = "http://127.0.0.1:442";
  process.env.UNRAID_API_KEY = "test-read-key";
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
  resetEnvCache();
}


function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

/* Auth ---------------------------------------------------------------------- */

describe("auth: disabled mode", () => {
  beforeEach(() => baseEnv({ AUTH_MODE: "disabled" }));

  it("allows everything and reports the mode", () => {
    const result = resolveAuth(headers(), null);
    assert.equal(result.allowed, true);
    assert.equal(result.identity.mode, "disabled");
    assert.equal(result.identity.user, null);
  });
});

describe("auth: proxy mode (v0.7.6 hybrid)", () => {
  beforeEach(() => {
    baseEnv({
      AUTH_MODE: "proxy",
      AUTH_HEADER: "X-Forwarded-User",
      AUTH_PROXY_SECRET: "test-secret-0123456789abcdef",
      AUTH_PROXY_SECRET_HEADER: "X-Dashboard-Auth-Token",
    });
    delete process.env.AUTH_ALLOWED_USERS;
    resetEnvCache();
  });

  it("accepts a proxied request carrying secret + identity header", () => {
    const result = resolveAuth(
      headers({
        "x-forwarded-for": "192.168.1.50",
        "x-forwarded-user": "remco",
        "x-dashboard-auth-token": "test-secret-0123456789abcdef",
      }),
      "unknown",
    );
    assert.equal(result.allowed, true);
    assert.equal(result.identity.user, "remco");
  });

  it("direct LAN access without secret = trusted-local, spoofed identity IGNORED", () => {
    const spoofs: Array<Record<string, string>> = [
      { "x-forwarded-for": "1.2.3.4", "x-forwarded-user": "admin" },
      { "x-forwarded-user": "admin" },
      { "x-forwarded-for": "10.0.0.1", "x-forwarded-user": "admin" },
    ];
    for (const spoof of spoofs) {
      const result = resolveAuth(headers(spoof), "unknown");
      assert.equal(result.allowed, true, JSON.stringify(spoof));
      assert.equal(result.identity.user, "trusted-local", "spoofed identity must not leak");
    }
  });

  it("rejects a WRONG secret (present but invalid — no fallback)", () => {
    const result = resolveAuth(
      headers({
        "x-forwarded-user": "remco",
        "x-dashboard-auth-token": "wrong-secret-0123456789abcdef",
      }),
      "unknown",
    );
    assert.equal(result.allowed, false);
    assert.equal(result.status, 401);
  });

  it("fails closed when no proxy secret is configured (direct request)", () => {
    delete process.env.AUTH_PROXY_SECRET;
    resetEnvCache();
    const result = resolveAuth(headers({ "x-forwarded-user": "remco" }), "unknown");
    assert.equal(result.allowed, false);
    assert.equal(result.status, 401);
  });

  it("rejects secret-carrying requests missing the identity header", () => {
    const result = resolveAuth(
      headers({ "x-dashboard-auth-token": "test-secret-0123456789abcdef" }),
      "unknown",
    );
    assert.equal(result.allowed, false);
    assert.equal(result.status, 401);
  });

  it("rejects users outside the allowlist (even with valid secret)", () => {
    process.env.AUTH_ALLOWED_USERS = "remco,admin";
    resetEnvCache();
    const result = resolveAuth(
      headers({
        "x-forwarded-user": "mallory",
        "x-dashboard-auth-token": "test-secret-0123456789abcdef",
      }),
      "unknown",
    );
    assert.equal(result.allowed, false);
    assert.equal(result.status, 403);
  });

  it("allows allowlisted users", () => {
    process.env.AUTH_ALLOWED_USERS = "remco";
    resetEnvCache();
    const result = resolveAuth(
      headers({
        "x-forwarded-user": "remco",
        "x-dashboard-auth-token": "test-secret-0123456789abcdef",
      }),
      "unknown",
    );
    assert.equal(result.allowed, true);
  });
});

/* IP helpers ----------------------------------------------------------------- */

describe("ip helpers", () => {
  it("classifies private and loopback addresses", () => {
    assert.equal(isPrivateIp("127.0.0.1"), true);
    assert.equal(isPrivateIp("192.168.1.2"), true);
    assert.equal(isPrivateIp("10.1.2.3"), true);
    assert.equal(isPrivateIp("172.16.0.1"), true);
    assert.equal(isPrivateIp("8.8.8.8"), false);
  });

  it("matches CIDR rules", () => {
    assert.equal(ipMatches("172.17.0.19", "172.17.0.0/16"), true);
    assert.equal(ipMatches("192.168.1.50", "172.17.0.0/16"), false);
    assert.equal(ipMatches("1.2.3.4", "*"), true);
    assert.equal(ipMatches("192.168.1.2", "private"), true);
  });
});

/* CSRF ------------------------------------------------------------------------ */

describe("same-origin (CSRF) check", () => {
  it("accepts matching origin/host", () => {
    assert.equal(
      checkSameOrigin(headers({ origin: "http://192.168.1.2:8090", host: "192.168.1.2:8090" }), null),
      null,
    );
  });

  it("rejects cross-site origins", () => {
    assert.match(
      checkSameOrigin(headers({ origin: "https://evil.example", host: "192.168.1.2:8090" }), null)!,
      /Cross-origin/,
    );
  });

  it("rejects missing origin", () => {
    assert.match(checkSameOrigin(headers({ host: "h" }), null)!, /Missing Origin/);
  });

  it("rejects malformed origin", () => {
    assert.match(
      checkSameOrigin(headers({ origin: ":::", host: "h" }), null)!,
      /Malformed/,
    );
  });
});

/* Policy ------------------------------------------------------------------------ */

describe("action policy", () => {
  beforeEach(() => {
    baseEnv({ ACTION_COOLDOWN_MS: "10000", ACTION_RATE_PER_MINUTE: "3" });
    resetPolicy();
  });

  it("allows the first action and applies cooldown after it", () => {
    const first = reserveAction("user", "docker", "id-1", "stop", 1_000);
    assert.equal(first.allowed, true);
    if (first.allowed) first.release();

    const second = reserveAction("user", "docker", "id-1", "stop", 2_000);
    assert.equal(second.allowed, false);
    if (!second.allowed) assert.match(second.reason, /Cooldown/);
  });

  it("does not cooldown across different targets or actions", () => {
    const a = reserveAction("user", "docker", "id-1", "start", 1_000);
    assert.equal(a.allowed, true);
    if (a.allowed) a.release();
    const b = reserveAction("user", "docker", "id-2", "start", 1_100);
    assert.equal(b.allowed, true);
    if (b.allowed) b.release();
    const c = reserveAction("user", "docker", "id-1", "stop", 1_200);
    assert.equal(c.allowed, true);
    if (c.allowed) c.release();
  });

  it("enforces the per-actor rate cap", () => {
    for (const [index, target] of ["t1", "t2", "t3"].entries()) {
      const decision = reserveAction("userA", "docker", target, "start", 5_000);
      assert.equal(decision.allowed, true, `action ${index} should pass`);
      if (decision.allowed) decision.release();
    }
    const fourth = reserveAction("userA", "docker", "t4", "start", 5_400);
    assert.equal(fourth.allowed, false);
    if (!fourth.allowed) assert.match(fourth.reason, /Rate limit/);
    // Other actors unaffected.
    const other = reserveAction("userB", "docker", "t4", "start", 5_400);
    assert.equal(other.allowed, true);
    if (other.allowed) other.release();
  });

  it("rejects concurrent actions on the same target", () => {
    const first = reserveAction("user", "docker", "same-id", "start", 9_000);
    assert.equal(first.allowed, true);
    const second = reserveAction("user", "docker", "same-id", "stop", 9_100);
    assert.equal(second.allowed, false);
    if (!second.allowed) assert.match(second.reason, /in progress/);
    if (first.allowed) first.release();
  });

  it("builds stable cooldown keys", () => {
    assert.equal(cooldownKey("docker", "x", "start"), "docker:x:start");
  });
});

/* Audit ------------------------------------------------------------------------ */

describe("audit log", () => {
  beforeEach(() => {
    baseEnv({ AUDIT_DIR: "/tmp/ud-test-audit" });
    resetAuditQueue();
  });

  it("records entries without credential material", async () => {
    const id = await recordAudit({
      actor: "remco",
      sourceIp: "192.168.1.50",
      kind: "docker",
      action: "stop",
      targetName: "Dozzle",
      targetId: "abc:uuid",
      result: "success",
      durationMs: 120,
      error: "x-api-key=supersecret token=abc123",
    });
    assert.match(id, /^a/);
    const { entries } = await readAudit(50);
    const mine = entries.find((entry) => entry.id === id);
    assert.ok(mine);
    assert.equal(mine.actor, "remco");
    assert.equal(mine.targetName, "Dozzle");
    // Secret-looking material is scrubbed from error summaries.
    assert.ok(!JSON.stringify(mine).includes("supersecret"));
    assert.ok(!JSON.stringify(mine).includes("token=abc123"));
  });
});
