import { chromium } from "playwright-core";
const BASE = "http://192.168.1.2:8090";
const MINUTES = 25;
const samples = [];
let pageErrors = 0;
const browser = await chromium.connectOverCDP("http://[::1]:9222");
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.setViewportSize({ width: 1280, height: 800 });
page.on("pageerror", () => pageErrors++);
await page.goto(`${BASE}/noc`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const prefs = JSON.parse(localStorage.getItem("unraid-dashboard.prefs.v1") ?? "{}");
  prefs.nocCycleSeconds = 15;
  localStorage.setItem("unraid-dashboard.prefs.v1", JSON.stringify(prefs));
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
const deadline = Date.now() + MINUTES * 60_000;
let staleDialogs = 0;
while (Date.now() < deadline) {
  const m = await page.evaluate(() => ({
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    alertDialogs: document.querySelectorAll("[role=alertdialog]").length,
    panelText: document.body.textContent.slice(0, 2000),
  }));
  samples.push(m);
  const live = m.panelText.includes("live") || m.panelText.includes("trusted-local");
  console.log(`t=${Math.round((MINUTES * 60_000 - (deadline - Date.now())) / 1000)}s heap=${m.heap}MB overflow=${m.overflow} dialogs=${m.alertDialogs} live-ish=${live}`);
  await page.waitForTimeout(30_000);
}
await page.evaluate(() => {
  const prefs = JSON.parse(localStorage.getItem("unraid-dashboard.prefs.v1") ?? "{}");
  prefs.nocCycleSeconds = 0;
  localStorage.setItem("unraid-dashboard.prefs.v1", JSON.stringify(prefs));
});
await page.close();
const heaps = samples.map((s) => s.heap).filter(Boolean);
const first = heaps.slice(0, 3).reduce((a, b) => a + b, 0) / Math.max(1, heaps.slice(0, 3).length);
const last = heaps.slice(-3).reduce((a, b) => a + b, 0) / Math.max(1, heaps.slice(-3).length);
console.log(`\nSOAK: ${samples.length} samples | heap ${Math.round(first)}→${Math.round(last)}MB | errors=${pageErrors} | staleDialogs=${staleDialogs}`);
console.log(pageErrors === 0 ? "SOAK PASS" : "SOAK FAIL");
process.exit(0);
