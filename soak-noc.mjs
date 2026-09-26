/* Sustained NOC/kiosk soak (§46): memory stability, layout drift, SSE. */
import { chromium } from "playwright-core";

const BASE = process.env.SOAK_BASE ?? "http://127.0.0.1:8095";
const MINUTES = Number(process.env.SOAK_MINUTES ?? 10);
const samples = [];
let consoleErrorCount = 0;

const browser = await chromium.connectOverCDP("http://[::1]:9222");
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
page.on("pageerror", () => consoleErrorCount++);

await page.goto(`${BASE}/noc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);

// Auto-cycle 15s + kiosk rail navigation exercised periodically.
await page.evaluate(() => {
  const prefs = JSON.parse(window.localStorage.getItem("unraid-dashboard.prefs.v1") ?? "{}");
  prefs.nocCycleSeconds = 15;
  window.localStorage.setItem("unraid-dashboard.prefs.v1", JSON.stringify(prefs));
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);

const deadline = Date.now() + MINUTES * 60_000;
let tick = 0;
let sseDisconnects = 0;
let lastSse = "unknown";
let layoutDrift = false;

while (Date.now() < deadline) {
  tick += 1;
  const metrics = await page.evaluate(() => ({
    heapMb: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    scrollW: document.documentElement.scrollWidth,
    clientW: document.documentElement.clientWidth,
    panels: document.body.textContent.includes("Docker —") ? "docker" : "overview/other",
    live: document.body.textContent.includes("live"),
  }));
  samples.push(metrics);
  console.log(
    `t=${Math.round((MINUTES * 60_000 - (deadline - Date.now())) / 1000)}s tick=${tick} heap=${metrics.heapMb}MB panel=${metrics.panels} overflow=${metrics.scrollW > metrics.clientW + 1}`,
  );
  if (metrics.scrollW > metrics.clientW + 1) layoutDrift = true;
  if (metrics.live === false) sseDisconnects += 1;
  await page.waitForTimeout(20_000);
}

// Restore prefs and report.
await page.evaluate(() => {
  const prefs = JSON.parse(window.localStorage.getItem("unraid-dashboard.prefs.v1") ?? "{}");
  prefs.nocCycleSeconds = 0;
  window.localStorage.setItem("unraid-dashboard.prefs.v1", JSON.stringify(prefs));
});
await page.close();

const heaps = samples.map((sample) => sample.heapMb).filter((value) => value !== null);
const first = heaps.slice(0, 3).reduce((a, b) => a + b, 0) / Math.max(1, heaps.slice(0, 3).length);
const last = heaps.slice(-3).reduce((a, b) => a + b, 0) / Math.max(1, heaps.slice(-3).length);
const growth = first > 0 ? Math.round(((last - first) / first) * 100) : 0;
console.log(`\n==== SOAK RESULT (${MINUTES} min, ${samples.length} samples) ====`);
console.log(`heap first≈${Math.round(first)}MB last≈${Math.round(last)}MB growth=${growth}%`);
console.log(`layout drift: ${layoutDrift ? "DETECTED" : "none"}`);
console.log(`page errors: ${consoleErrorCount}`);
console.log(`samples without live state: ${sseDisconnects}`);
const ok = growth < 60 && !layoutDrift && consoleErrorCount === 0;
console.log(ok ? "SOAK PASS" : "SOAK FAIL");
process.exit(ok ? 0 : 1);
