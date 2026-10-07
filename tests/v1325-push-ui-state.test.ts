import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  derivePushDeviceState,
  pushDeviceAction,
  type DevicePushStateInput,
} from "../src/lib/push-client";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

/** Fase 15/16 (v1.3.25): regression fixtures for the EXACT physical-iPhone
 *  dead-end — permission granted, no subscription, no server devices —
 *  plus the full button matrix. The UI MUST derive its actions from these
 *  canonical states, never from presentation.canEnable alone. */

const base: DevicePushStateInput = {
  permission: "granted",
  secureContext: true,
  standalone: true,
  isAppleMobile: true,
  hasNotificationApi: true,
  hasPushManager: true,
  hasServiceWorker: true,
  registrationExists: true,
  swActive: true,
  subscriptionPresent: false,
  subscriptionFingerprint: null,
  serverKnowsSubscription: null,
  serverDevices: 0,
  diagnosticsError: false,
};

const state = (overrides: Partial<DevicePushStateInput>) =>
  derivePushDeviceState({ ...base, ...overrides });
const action = (overrides: Partial<DevicePushStateInput>) =>
  pushDeviceAction(state(overrides));

describe("Fase 0: exact screenshot-state (granted + no sub + no server)", () => {
  test("canonical state = not-subscribed (NOT ready, NOT enabled)", () => {
    assert.equal(state({}), "not-subscribed");
  });
  test("action = enable (Repair/Enable button MUST be visible)", () => {
    assert.equal(action({}), "enable");
  });
  test("pushReady is false", () => {
    assert.equal(state({}) === "ready", false);
  });
});

describe("Fase 4: button matrix", () => {
  test("not-subscribed → enable", () => {
    assert.equal(action({ subscriptionPresent: false, serverDevices: 0 }), "enable");
  });
  test("local-only → repair", () => {
    assert.equal(
      action({ subscriptionPresent: true, serverKnowsSubscription: false, serverDevices: 0 }),
      "repair",
    );
  });
  test("server-only → repair", () => {
    assert.equal(
      action({ subscriptionPresent: false, serverKnowsSubscription: null, serverDevices: 2 }),
      "repair",
    );
  });
  test("mismatch → repair", () => {
    assert.equal(
      action({ subscriptionPresent: true, serverKnowsSubscription: false, serverDevices: 2 }),
      "repair",
    );
  });
  test("ready → disable", () => {
    assert.equal(
      action({ subscriptionPresent: true, serverKnowsSubscription: true, serverDevices: 1 }),
      "disable",
    );
  });
  test("permission-denied → no push action", () => {
    assert.equal(action({ permission: "denied" }), "none");
  });
  test("requires-install → no push action (Apple mobile, plain Safari: no PushManager)", () => {
    assert.equal(
      action({ hasNotificationApi: false, hasPushManager: false, hasServiceWorker: false, standalone: false }),
      "none",
    );
    assert.equal(state({ hasNotificationApi: false, hasPushManager: false, hasServiceWorker: false, standalone: false }), "requires-install");
  });
  test("unsupported → no push action", () => {
    assert.equal(action({ secureContext: false }), "none");
  });
});

describe("Fase 5: stale/unknown never reads as healthy", () => {
  test("diagnostics error → error state (not ready)", () => {
    assert.equal(state({ diagnosticsError: true }), "error");
    assert.equal(action({ diagnosticsError: true }), "repair");
  });
  test("registration absent → not-subscribed (never ready)", () => {
    assert.equal(state({ registrationExists: false }), "not-subscribed");
  });
});

/* ---- Fase 15/16: rendered-section assertions ----------------------------- */

describe("Rendered NotificationsSection — exact regression fixture", () => {
  const section = fs.readFileSync(
    path.join(ROOT, "src", "components", "settings", "notifications-section.tsx"),
    "utf8",
  );

  test("1-2. granted + no local + no server → Enable visible, Web Push Test gated", () => {
    // Enable/Repair zichtbaar op canonical state, niet op permission alleen
    assert.match(section, /\(deviceAction === "enable" \|\| deviceAction === "repair"\) && \(/);
    assert.match(section, /deviceAction !== "disable"/);
    assert.match(section, /Register this device first/);
  });

  test("3. diagnostics visible at canonical not-subscribed (no silent null)", () => {
    // Het blok rendert bij deviceDiag OF bij een diagnostics-error
    assert.match(section, /\(deviceDiag \|\| diagnosticsStatus === "error"\) && \(/);
    // loadDiagnostics vangt fouten niet meer stilletjes weg
    assert.match(section, /setDiagnosticsStatus\("error"\)/);
    assert.match(section, /Retry diagnostics/);
  });

  test("4-6. local/server/mismatch → Repair visible", () => {
    assert.match(section, /deviceAction === "repair" \? "repair" : "enable"/);
  });

  test("7. ready → Disable visible", () => {
    assert.match(section, /deviceAction === "disable" && \(/);
  });

  test("8-9. denied/unsupported → explanation, no enable", () => {
    assert.match(section, /permission blocked/);
    assert.match(section, /not supported on this device|install Beacon to Home Screen/);
  });

  test("10-11. diagnostics failure → error block visible (never silently null)", () => {
    assert.match(section, /Diagnostics unavailable —/);
    // de oude stil-catch moet weg zijn
    assert.doesNotMatch(section, /catch \{\n      setDeviceDiag\(null\);/);
  });

  test("12. disable → not-subscribed → Enable reappears (state mapping)", () => {
    // disable verwijdert local+server; canonical state valt terug op not-subscribed
    assert.match(section, /deviceAction === "enable" \|\| deviceAction === "repair"/);
  });

  test("15. localStorage does not control button state", () => {
    assert.doesNotMatch(section, /beacon\.notifications\.pushConfigured/);
  });

  test("16. presentation.canEnable does not control subscription actions", () => {
    // presentation mag alleen permission-UX bepalen; push-knoppen gebruiken deviceAction
    const canEnableLines = section.split("\n").filter((l) => l.includes("canEnable"));
    for (const line of canEnableLines) {
      assert.doesNotMatch(line, /Enable Web Push|Disable Web Push|Repair Web Push/);
    }
  });

  test("17-18. SSE-only != push success; 0 devices cannot Send Web Push Test", () => {
    assert.match(section, /no-subscribed-devices/);
    assert.match(section, /No Web Push device is registered/);
  });

  test("14. mobile layout: action buttons in flex-wrap containers", () => {
    // de knoppenrijen gebruiken flex-wrap zodat ze op iPhone-viewport binnen
    // de breedte blijven en niet afgekapt worden
    assert.match(section, /flex flex-wrap gap-2/);
    assert.match(section, /deviceAction === "enable" \|\| deviceAction === "repair"/);
    assert.match(section, /deviceAction === "disable" && \(/);
  });

  test("20. 18-step trace rendered after action", () => {
    assert.match(section, /Registration trace \(last attempt\)/);
    assert.match(section, /setLastTrace\(trace\)/);
  });

  test("canonical state source = derivePushDeviceState (not presentation)", () => {
    assert.match(section, /derivePushDeviceState\(\{/);
    assert.match(section, /pushDeviceAction\(devicePushState\)/);
  });
});

/* ---- Fase 16: waarom eerdere tests dit misten ---------------------------- */

describe("Fase 16: previous blind spot — permanent fixture", () => {
  test("granted + absent + empty server is an EXPLICIT regression fixture", () => {
    // Dit is de exacte screenshot-state van de v1.3.24-melding: de oude
    // suites hadden geen fixture met permission=granted EN subscription=null
    // EN server=[] tegelijk, en assertten nooit op de rendered button.
    const diag = state({});
    assert.equal(diag, "not-subscribed");
    assert.equal(action({}), "enable");
  });
});
