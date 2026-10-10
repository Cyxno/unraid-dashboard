import playwright from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:8099";
const OUT = "docs/screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"],
});

/* Real demo instance: persistence-failure incident with its runbook. */
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 940 });
await page.goto(`${BASE}/incidents/beacon%3Apersistence`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/incident-runbook-v170.png`, fullPage: true });
console.log("saved incident-runbook-v170.png");

/* Mobile runbook — viewport shot (fullPage stitches fixed nav mid-page) */
const mobile = await browser.newPage();
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.goto(`${BASE}/incidents/beacon%3Apersistence`, { waitUntil: "domcontentloaded" });
await mobile.waitForTimeout(6000);
const runbookHeading = mobile.getByText("Runbook", { exact: false }).first();
const box = await runbookHeading.boundingBox();
if (box) {
  await mobile.evaluate((y) => window.scrollTo(0, y), Math.max(0, box.y + (await mobile.evaluate(() => window.scrollY)) + 300));
} else {
  await mobile.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.35));
}
await mobile.waitForTimeout(800);
await mobile.screenshot({ path: `${OUT}/mobile-runbook-v170.png` });
console.log("saved mobile-runbook-v170.png");
await mobile.close();

/* Synthetic crash-loop payload (fixture-only, never live) for the guarded
   confirmation + operation progress shots. */
const synthetic = {
  incident: {
    id: "docker:container:demo-app:crash-loop",
    entity: "demo-app",
    kind: "crash-loop",
    title: "Crash loop: demo-app",
    severity: "critical",
    status: "active",
    firstSeenAt: new Date(Date.now() - 14 * 60_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    durationMs: 14 * 60_000,
    source: "unraid-api",
    evidence: [
      { entity: "demo-app", signal: "docker.status", source: "unraid-api", observedAt: new Date().toISOString(), freshness: "fresh", value: 'status="Restarting (1) 12 seconds ago"', rule: null, evidenceType: "direct" },
      { entity: "demo-app", signal: "docker.restartFrequency", source: "unraid-api", observedAt: new Date().toISOString(), freshness: "fresh", value: "7 restart(s) in 10m window", rule: "crash-loop.frequency", evidenceType: "derived" },
    ],
    rootCauseId: null,
    impact: ["container is restart-looping — workload availability unstable"],
    notifiedAt: null,
    resolvedAt: null,
    flapping: false,
    actionable: true,
    timeline: [
      { at: new Date(Date.now() - 60_000).toISOString(), event: "incident opened", detail: "7 restart(s) in 10m window" },
    ],
    safeCheck: "Inspect container logs for the failing process before any restart change.",
    delivery: null,
  },
  source: null,
  confidence: { level: "full", reasons: [] },
  runbook: {
    scope: "crash-loop",
    explanation: "The container shows a proven restart pattern (sustained restarting status or repeated restart deltas inside the window). One manual restart is never classified as a crash loop.",
    prerequisites: ["Unraid API usable (docker health evidence requires it)", "restart pattern evidence is present in this incident"],
    diagnosticChecks: [
      { title: "Inspect restart evidence", detail: "The incident shows the restart pattern: how many restarts in the window, plus the sustained restarting status if applicable." },
      { title: "Read container logs", detail: "Open the container detail page and read the logs of the failing process before considering any lifecycle change." },
      { title: "Correlate with update/deploy history", detail: "Check the container's update history — a crash loop that started right after an update is a rollback candidate, not a restart candidate." },
    ],
    actionIds: ["diagnostic:refresh-incident-evidence", "guarded:docker-stop"],
    verification: [
      { title: "Health observed healthy", detail: "Docker reports the container running with passing healthchecks over multiple consecutive checks." },
      { title: "Incident recovered", detail: "This incident closes itself when the engine positively observes the condition absent." },
    ],
    manualRecovery: [
      "Stop the container from this runbook (confirmed action) if it is crash-looping in a way that harms other workloads.",
      "Fix the failing process or configuration in the Unraid Docker UI.",
    ],
    escalation: "Escalate when restarts continue after a configuration fix, or when the crash loop correlates with a failed update.",
  },
  actions: [
    { id: "diagnostic:refresh-incident-evidence", incidentId: "docker:container:demo-app:crash-loop", entity: "demo-app", type: "refresh-incident-evidence", title: "Refresh incident evidence", description: "Re-runs the incident evaluation over the latest cached data.", risk: "safe", requiresConfirmation: false, requiresPrivilege: "none", reversible: true, preconditions: ["incident still active"], verification: ["fresh evidence appears in the incident"], cooldownMs: 30000 },
    { id: "guarded:docker-stop", incidentId: "docker:container:demo-app:crash-loop", entity: "demo-app", type: "docker-stop", title: "Stop container (confirmed)", description: "Runs the existing confirmed Docker stop for this container as containment for the crash loop.", risk: "guarded", requiresConfirmation: true, requiresPrivilege: "actions", reversible: true, preconditions: ["write actions enabled on this server", "container present in the live inventory with a known state", "no conflicting operation on this container", "no dashboard update in progress", "cooldown clear"], verification: ["Docker reports the container EXITED from the live inventory", "incident engine re-evaluates on the next cycle"], cooldownMs: 10000 },
  ],
  operations: [
    { id: "opdemo1", entity: "demo-app", operation: "docker-stop", incidentId: "docker:container:demo-app:crash-loop", actor: "operator", state: "succeeded", startedAt: new Date(Date.now() - 45_000).toISOString(), updatedAt: new Date().toISOString(), timeoutAt: new Date(Date.now() + 75_000).toISOString(), traceId: null, message: "Docker reports EXITED (verified via live inventory)", timeline: [
      { at: new Date(Date.now() - 20_000).toISOString(), event: "state → succeeded", detail: "Docker reports EXITED (verified via live inventory)" },
      { at: new Date(Date.now() - 30_000).toISOString(), event: "state → verifying", detail: "mutation accepted — observing actual effect" },
      { at: new Date(Date.now() - 45_000).toISOString(), event: "user confirmed: Stop container (confirmed)", detail: "actor operator" },
    ] },
  ],
  demoActive: false,
};

const mocked = await browser.newPage();
await mocked.setViewportSize({ width: 1440, height: 940 });
await mocked.route("**/api/incidents/**", (route) =>
  route.fulfill({ json: synthetic }),
);
await mocked.goto(`${BASE}/incidents/docker%3Acontainer%3Ademo-app%3Acrash-loop`, { waitUntil: "domcontentloaded" });
await mocked.waitForTimeout(3000);
const bodyText = await mocked.textContent("body");
if (!bodyText.includes("Open confirmation")) {
  console.error("DEBUG body:", bodyText.slice(0, 600).replace(/\s+/g, " "));
}
await mocked.screenshot({ path: `${OUT}/incident-operations-v170.png`, fullPage: true });
console.log("saved incident-operations-v170.png");

await mocked.getByText("Open confirmation", { exact: false }).first().click();
await mocked.waitForTimeout(800);
await mocked.screenshot({ path: `${OUT}/guarded-confirmation-v170.png` });
console.log("saved guarded-confirmation-v170.png");

await browser.close();
