import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Permission presentation truth table (v1.2.2 regression).
 *
 * v1.2.1 regression: browsers report Notification.permission === "denied"
 * for reasons that are NOT a per-site user choice — plain-HTTP (insecure)
 * contexts, global browser toggles, private windows. The section treated
 * every "denied" as "the user blocked this site in site settings", which
 * is impossible to follow in an insecure context. The presentation now
 * classifies: insecure context first, then browser support, iOS install
 * state, and only then the actual permission value.
 */

import {
  derivePermissionPresentation,
  evaluatePushSupport,
} from "../src/lib/push-support";

const secure = { secureContext: true, isAppleMobile: false, standalone: false };

describe("permission presentation truth table", () => {
  it("permission default (secure) → not asked, NOT blocked, enable possible", () => {
    const result = derivePermissionPresentation({ permission: "default", supportKind: "supported" });
    assert.equal(result.badge, "not-asked");
    assert.equal(result.message, null);
    assert.equal(result.canEnable, true);
  });

  it("permission granted (secure) → granted, NOT blocked", () => {
    const result = derivePermissionPresentation({ permission: "granted", supportKind: "supported" });
    assert.equal(result.badge, "granted");
    assert.equal(result.message, null);
    assert.equal(result.canEnable, false);
  });

  it("permission denied (secure) → blocked with actionable site-settings advice", () => {
    const result = derivePermissionPresentation({ permission: "denied", supportKind: "supported" });
    assert.equal(result.badge, "blocked");
    assert.match(result.message ?? "", /site permissions/);
    assert.equal(result.canEnable, false);
  });

  it("permission granted + VAPID missing → granted badge; push-not-configured is a separate surface", () => {
    // The presentation is intentionally permission-only: server VAPID state
    // is its own badge and must never masquerade as a permission failure.
    const result = derivePermissionPresentation({ permission: "granted", supportKind: "supported" });
    assert.equal(result.badge, "granted");
    assert.doesNotMatch(result.message ?? "", /configur/i);
  });

  it("permission default + VAPID missing → still 'not asked', never blocked", () => {
    const result = derivePermissionPresentation({ permission: "default", supportKind: "supported" });
    assert.equal(result.badge, "not-asked");
  });

  it("unsupported browser → not supported (regardless of permission)", () => {
    for (const permission of ["default", "granted", "denied"] as const) {
      const result = derivePermissionPresentation({ permission, supportKind: "unsupported-browser" });
      assert.equal(result.badge, "not-supported");
      assert.equal(result.canEnable, false);
    }
  });

  it("insecure context (HTTP) → HTTPS required, NEVER the site-settings advice", () => {
    // The regression: insecure contexts report permission 'denied' in
    // Chromium and Firefox; the old UI told users to 're-enable in site
    // settings', which is impossible over plain HTTP.
    for (const permission of ["default", "denied", "granted"] as const) {
      const result = derivePermissionPresentation({ permission, supportKind: "insecure-context" });
      assert.equal(result.badge, "requires-https");
      assert.match(result.message ?? "", /HTTPS/);
      assert.doesNotMatch(result.message ?? "", /site settings|padlock/i);
      assert.equal(result.canEnable, false);
    }
  });

  it("iOS Safari not installed → install required, even with permission denied", () => {
    const result = derivePermissionPresentation({ permission: "denied", supportKind: "ios-needs-install" });
    assert.equal(result.badge, "install-required");
    assert.match(result.message ?? "", /Home Screen/);
  });

  it("iOS installed + permission default → permission not requested (not install-required)", () => {
    const support = evaluatePushSupport({
      hasNotificationApi: true,
      hasPushManager: true,
      hasServiceWorker: true,
      secureContext: true,
      isAppleMobile: true,
      standalone: true,
    });
    assert.equal(support.kind, "supported");
    const result = derivePermissionPresentation({ permission: "default", supportKind: support.kind });
    assert.equal(result.badge, "not-asked");
    assert.equal(result.canEnable, true);
  });

  it("permission unsupported → not supported", () => {
    const result = derivePermissionPresentation({ permission: "unsupported", supportKind: "supported" });
    assert.equal(result.badge, "not-supported");
  });
});
