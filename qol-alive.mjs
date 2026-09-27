import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://[::1]:9222");
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto("http://192.168.1.2:8090/docker", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
// 1. Werkt "Check now" (tekst verandert naar Checking…)?
const check = page.getByRole("button", { name: /Check now/i }).first();
console.log("check-now aanwezig:", (await check.count()) > 0);
if (await check.count()) {
  await check.click();
  await page.waitForTimeout(400);
  console.log("check-now reageert:", (await check.textContent())?.includes("Checking"));
}
// 2. Bestaat de update-knop en is die enabled?
const btn = page.locator('button[aria-label^="Update "]').first();
console.log("update-knoppen:", await page.locator('button[aria-label^="Update "]').count());
if (await btn.count()) {
  console.log("disabled:", await btn.isDisabled(), "| aria:", await btn.getAttribute("aria-label"));
  await btn.scrollIntoViewIfNeeded();
  await btn.click({ force: false });
  await page.waitForTimeout(500);
  console.log("alertdialog:", await page.locator("[role=alertdialog]").count());
}
await page.close();
process.exit(0);
