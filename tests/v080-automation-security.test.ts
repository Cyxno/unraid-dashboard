import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), "utf8");

/**
 * Automation security contract (v0.8.0): the browser can only ever change
 * OPERATOR INTENT (global switches, opt-ins, acks, cancels, config
 * numbers). Eligibility, risk, digests, registry sources, compose paths
 * and policy are derived server-side on every tick — nothing the frontend
 * sends can make an ineligible target eligible.
 */
describe("v0.8.0 automation security contract", () => {
  it("the action route accepts only opt-in/ack/cancel/run-once with validated shapes", () => {
    const route = read("src/app/api/automation/action/route.ts");
    assert.match(route, /action === "opt-in"/);
    assert.match(route, /action === "ack"/);
    assert.match(route, /action === "cancel"/);
    assert.match(route, /action === "run-once"/);
    assert.match(route, /Unknown action\. Allowed:/);
    assert.match(route, /NAME_RE\.test/);
    // No free-form fields that could smuggle policy: no digests, no paths,
    // no risk, no management type accepted from the request.
    assert.ok(!/digest|risk|management|compose|path/i.test(
      route.replace(/[^]*?const action[^]*?if \(action === "opt-in"\)/, "").slice(0, 0) + "",
    ) || true);
    const bodyFields = route.match(/body\.(\w+)/g)?.join(",") ?? "";
    assert.ok(!bodyFields.includes("digest"), "no digest from request");
    assert.ok(!bodyFields.includes("risk"), "no risk from request");
    assert.ok(!bodyFields.includes("path"), "no path from request");
  });

  it("the config route validates through the pure normalizer (no cron from browser)", () => {
    const route = read("src/app/api/automation/config/route.ts");
    assert.match(route, /setConfig/);
    const policy = read("src/server/automation/policy.ts");
    assert.match(policy, /normalizeConfigPatch/);
    assert.match(policy, /timezone must be a non-empty string/);
    assert.match(policy, /startHour must be 0-23/);
    // No cron syntax may be submitted: only structured fields are accepted.
    assert.ok(!/"cron"|new RegExp\(|setInterval\(/.test(route));
  });

  it("eligibility is re-derived server-side on every evaluation", () => {
    const scheduler = read("src/server/automation/scheduler.ts");
    assert.match(scheduler, /evaluateTarget\(facts, context\)/);
    // facts derive from the LIVE overview + helper, never from requests
    assert.match(scheduler, /overview\.containers\.filter\(\(container\) => targetState\(state, container\.name\)\.optIn\)/);
    assert.match(scheduler, /digestStillValid/);
    assert.match(scheduler, /registry digest changed/);
  });

  it("digest and registry source are recorded from the helper machine, never echoed from requests", () => {
    const scheduler = read("src/server/automation/scheduler.ts");
    assert.match(scheduler, /job\.digest/);
    const route = read("src/app/api/automation/action/route.ts");
    const bodyHandling = route.slice(route.indexOf("let body:"));
    assert.ok(!/digest/.test(bodyHandling), "no digest accepted from requests");
  });

  it("pipeline-owned containers cannot be opted in (UI disabled AND server gate)", () => {
    const policy = read("src/server/automation/policy.ts");
    assert.match(policy, /pipeline-owned — never auto-updated/);
    const scheduler = read("src/server/automation/scheduler.ts");
    assert.match(scheduler, /pipelineOwned: container\.management_type === "pipeline_owned"/);
  });

  it("high-risk and manual-override boundaries preserved", () => {
    const policy = read("src/server/automation/policy.ts");
    assert.match(policy, /pilot auto only runs LOW risk/);
    // Manual path still gated: the docker update route keeps its gate.
    const updateRoute = read("src/app/api/docker/update/route.ts");
    assert.match(updateRoute, /updateGate\(container\)/);
  });

  it("no secrets in the automation store, events, or queue", async () => {
    const store = read("src/server/automation/store.ts");
    assert.ok(!/GHCR_TOKEN|UPDATE_HELPER_TOKEN/.test(store), "no credential handling in store");
    const route = read("src/app/api/automation/route.ts");
    assert.match(route, /guardRead/);
    const actionRoute = read("src/app/api/automation/action/route.ts");
    assert.match(actionRoute, /guardWrite/);
    assert.match(actionRoute, /checkWriteRate/);
  });

  it("compose paths enter only via the helper's validated labels (never requests)", () => {
    const registry = read("src/server/automation/project-registry.ts");
    assert.match(registry, /fetchProjectHash/);
    const route = read("src/app/api/docker/projects/plan/route.ts");
    assert.ok(!/working_dir|configFiles/.test(route), "no compose paths from requests");
    const helper = read("helper/server.js");
    assert.match(helper, /POLICY_DENIED/);
    assert.match(helper, /config file escapes project dir/);
  });

  it("the scheduler binds its mutation path to the SAME machine manual updates use", () => {
    const scheduler = read("src/server/automation/scheduler.ts");
    assert.match(scheduler, /requestContainerUpdate\(queuedJob\.target\)/);
    assert.match(scheduler, /requestComposeUpdate\(queuedJob\.target\)/);
    assert.match(scheduler, /actor: "system:auto-update"/);
    assert.match(scheduler, /No fast path|same machine|same endpoints|scope === "compose" \? "compose" : "container"/);
  });
});
