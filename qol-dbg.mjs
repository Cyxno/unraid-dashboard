import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://[::1]:9222");
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto("http://192.168.1.2:8090/docker", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);
const btn = page.locator('button[aria-label^="Update "]').first();
await btn.scrollIntoViewIfNeeded().catch(() => {});
await btn.click();
await page.waitForTimeout(400);
const diag = await page.evaluate(() => ({
  portals: document.body.querySelectorAll("[role=alertdialog]").length,
  dialogs: document.body.querySelectorAll("[role=dialog]").length,
  lastBodyChild: document.body.lastElementChild?.tagName,
  bodyChildren: document.body.children.length,
}));
console.log(JSON.stringify(diag));
console.log("btn html:", await btn.evaluate((el) => el.outerHTML.slice(0, 160)));
await page.close();
process.exit(0);
