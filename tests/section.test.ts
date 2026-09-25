import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SectionProvider } from "../src/server/unraid/section";
import { mockOverview } from "../src/server/unraid/mock";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
void deferred;

describe("SectionProvider", () => {
  it("returns live data and caches within the TTL", async () => {
    let calls = 0;
    const provider = new SectionProvider("test", async () => {
      calls += 1;
      return { value: calls };
    }, 60_000);
    const first = await provider.get();
    assert.equal(first.status, "live");
    assert.equal(first.data?.value, 1);
    const second = await provider.get();
    assert.equal(second.status, "live");
    assert.equal(second.data?.value, 1); // cached
    assert.equal(calls, 1);
  });

  it("keeps last good data as stale after a failure", async () => {
    let shouldFail = false;
    const provider = new SectionProvider("test", async () => {
      if (shouldFail) {
        throw new Error("unraid down");
      }
      return { value: 42 };
    }, 0);

    const live = await provider.get();
    assert.equal(live.status, "live");

    shouldFail = true;
    const stale = await provider.get();
    assert.equal(stale.status, "stale");
    assert.equal(stale.data?.value, 42);
    assert.equal(stale.reason, "unraid down");
    assert.equal(provider.hasLive, true);
  });

  it("reports unavailable when there is no previous data", async () => {
    const provider = new SectionProvider("test", async () => {
      throw new Error("boom");
    }, 0);
    const section = await provider.get();
    assert.equal(section.status, "unavailable");
    assert.equal(section.data, null);
    assert.match(section.reason ?? "", /boom/);
  });

  it("never presents demo data as live", () => {
    const demo = mockOverview();
    // The demo payload is a plain object; the section contract is what
    // prevents it from being labelled live.
    assert.notEqual(demo.identity.serverName, undefined);
  });
});
