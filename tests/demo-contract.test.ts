import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Demo-substitution contract regression tests.
 *
 * v1.1.1 regression: `withDemo` replaced ANY section whose status was
 * "unavailable" with demo data — so a live server with one failing section
 * (missing key role, failing query, boot race) showed permanent "Demo"
 * labels. The contract (mock.ts, section.ts) is: demo ONLY while the Unraid
 * API has never responded this process. These tests lock that decision.
 */

import { applyDemoSubstitution } from "../src/server/unraid/service";
import { mockOverview } from "../src/server/unraid/mock";
import type { Section } from "../src/lib/api-types";

function sectionOf<T>(status: Section<unknown>["status"], reason?: string): Section<T> {
  return {
    status,
    data: status === "unavailable" ? null : ({ v: 1 } as unknown as T),
    fetchedAt: "2026-10-02T00:00:00.000Z",
    ageMs: 0,
    reason,
  };
}

describe("demo substitution contract", () => {
  const demo = mockOverview().identity;

  it("substitutes demo only when demo mode is active and the section is unavailable", () => {
    const result = applyDemoSubstitution(true, sectionOf("unavailable", "boot race"), demo);
    assert.equal(result.status, "demo");
    assert.equal(result.reason, "boot race");
  });

  it("keeps a failed section unavailable on a live server (never labels it Demo)", () => {
    // The regression: live server + one failing section -> demo chip.
    const result = applyDemoSubstitution(false, sectionOf("unavailable", "Unraid API responded with HTTP 403"), demo);
    assert.equal(result.status, "unavailable");
    assert.equal(result.reason, "Unraid API responded with HTTP 403");
    assert.equal(result.data, null);
  });

  it("never rewrites stale or live sections, even in demo mode", () => {
    for (const status of ["live", "stale"] as const) {
      const result = applyDemoSubstitution(true, sectionOf(status), demo);
      assert.equal(result.status, status);
      assert.deepEqual(result.data, { v: 1 });
    }
  });

  it("live server keeps every section untouched regardless of demo flags", () => {
    for (const status of ["live", "stale", "unavailable"] as const) {
      const result = applyDemoSubstitution(false, sectionOf(status, "x"), demo);
      assert.equal(result.status, status);
    }
  });
});
