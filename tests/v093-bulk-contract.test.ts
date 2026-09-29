import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const route = readFileSync(path.join(repoRoot, "src/app/api/notifications/bulk/route.ts"), "utf8");

/**
 * Bulk contract (v0.9.3): explicit modes, empty selected = error, never an
 * implicit "all". The upstream Unraid API treats archiveNotifications([])
 * as "archive everything" — our route must never forward an empty list.
 */
describe("v0.9.3 notification bulk contract", () => {
  it("requires an explicit mode: unread | all | selected", () => {
    assert.match(route, /mode === "unread"/);
    assert.match(route, /mode === "all"/);
    assert.match(route, /mode === "selected"/);
    assert.match(route, /Unknown mode\. Allowed: unread, all, selected\./);
  });

  it("mode selected requires non-empty ids (empty = validation error)", () => {
    assert.match(route, /Mode selected requires a non-empty ids array\./);
    assert.match(route, /body\.ids\.length === 0/);
  });

  it("caps selected ids and validates their shape", () => {
    assert.match(route, /MAX_IDS/);
    assert.match(route, /Invalid ids\./);
  });

  it("never forwards an empty ids array to the upstream mutation", () => {
    // The early-return guard for 0 targets fires BEFORE client.request.
    const earlyReturn = route.indexOf("ids.length === 0");
    const requestCall = route.indexOf("client.request(ARCHIVE_IDS");
    assert.ok(earlyReturn !== -1 && requestCall !== -1);
    assert.ok(earlyReturn < requestCall, "empty guard precedes the mutation");
  });

  it("mode all requires explicit confirmation", () => {
    assert.match(route, /Mode all requires explicit confirmation\./);
  });

  it("audits mode + target count, never notification bodies", () => {
    assert.match(route, /targetName: mode/);
    assert.match(route, /ids\.length.*archived|archived.*ids\.length/);
    assert.ok(!/description|body\.content|notification\.title/.test(route));
  });
});
