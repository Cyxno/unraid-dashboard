import playwright from "playwright-core";
const browser = await playwright.chromium.connectOverCDP("http://127.0.0.1:9223");
// 1. Header on overview page at 768 (is the collision pre-existing/page-specific?)
const ctx1 = await browser.newContext({ viewport: { width: 768, height: 900 } });
const p1 = await ctx1.newPage();
await p1.goto("http://192.168.1.2:8090/", { waitUntil: "domcontentloaded", timeout: 30000 });
await p1.waitForTimeout(4000);
await p1.screenshot({ path: "/root/unraid-dashboard/tmp-qa/overview-768-header.png" });
await ctx1.close();
// 2. Operations full-page at 390 (Release chain + recovery actions)
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 1000 } });
const p2 = await ctx2.newPage();
await p2.goto("http://192.168.1.2:8090/operations", { waitUntil: "domcontentloaded", timeout: 30000 });
await p2.waitForTimeout(6000);
const overflow = await p2.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
await p2.screenshot({ path: "/root/unraid-dashboard/tmp-qa/operations-390-full.png", fullPage: true });
console.log("operations-390-full overflow:", overflow);
await ctx2.close();
await browser.close();
