import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://[::1]:9222");
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push("PAGEERROR: " + e.message.slice(0, 200)));
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto("http://192.168.1.2:8090/docker", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);
// JS-dispatch (ongebruikt element → test of de handler attached is)
const fired = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label^="Update "]');
  if (!btn) return "geen knop";
  btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  return "click dispatched op: " + btn.getAttribute("aria-label");
});
console.log(fired);
await page.waitForTimeout(500);
console.log("alertdialog na JS-click:", await page.locator("[role=alertdialog]").count());
// Wat bedekt de knop? Element op de klikcoördinaten:
const cover = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label^="Update "]');
  if (!btn) return "geen knop";
  const r = btn.getBoundingClientRect();
  const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { btnTag: btn.tagName, btnDisabled: btn.disabled, coverTag: el?.tagName, coverIsBtn: el === btn, coverText: (el?.textContent ?? "").slice(0, 40) };
});
console.log("cover-check:", JSON.stringify(cover));
for (const e of errs) console.log(e.slice(0, 250));
await page.close();
process.exit(0);
