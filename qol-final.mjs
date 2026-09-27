import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://[::1]:9222");
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
await page.setViewportSize({ width: 1440, height: 900 });
let postSeen = false;
await page.route("**/api/docker/update", async (route) => {
  postSeen = true;
  await route.fulfill({ status: 202, contentType: "application/json", body: '{"accepted":true,"phase":"requested"}' });
});

// 1. Storage laadt
await page.goto("http://192.168.1.2:8090/storage", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const storage = await page.textContent("body");
console.log("1. storage laadt:", !storage.includes("couldn't load"), "| disk activity:", storage.includes("Disk activity"));

// 2. Docker: update-knop → dialoog → POST wiring
await page.goto("http://192.168.1.2:8090/docker", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(9000);
const btn = page.locator('button[aria-label^="Update "]').first();
console.log("2. update-knop:", (await btn.count()) > 0);
await btn.click();
await page.waitForTimeout(700);
console.log("   dialoog:", (await page.locator("[role=alertdialog]").count()) > 0);
await page.getByRole("button", { name: "Start update" }).click();
await page.waitForTimeout(1500);
console.log("   POST verstuurd:", postSeen, "| fase zichtbaar:", (await page.textContent("body")).includes("requested"));

// 3. NOC mobile: fullscreen-knop verbergen indien niet-ondersteund + drawer
const page2 = await context.newPage();
await page2.setViewportSize({ width: 390, height: 844 });
await page2.goto("http://192.168.1.2:8090/noc", { waitUntil: "domcontentloaded" });
await page2.waitForTimeout(3000);
// Chromium desktop ondersteunt fullscreen — knop zichtbaar; op iOS verborgen.
const fsBtn = await page2.getByRole("button", { name: /fullscreen/i }).count();
console.log("3. NOC fullscreen-knop (chromium: zichtbaar):", fsBtn > 0);
const ov = await page2.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
console.log("   NOC overflow:", ov);
await page2.screenshot({ path: "/tmp/qol-noc-final.png" });
await page2.close();
await page.close();
process.exit(0);
