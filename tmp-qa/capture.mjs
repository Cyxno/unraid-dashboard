import playwright from "playwright-core";
const BASE = "http://192.168.1.2:8090";
const OUT = "/root/unraid-dashboard/tmp-qa";
const browser = await playwright.chromium.connectOverCDP("http://127.0.0.1:9223");
const shots = [
  { path: "/operations", name: "operations-desktop", width: 1440, height: 1100 },
  { path: "/operations", name: "operations-390", width: 390, height: 1200 },
  { path: "/operations", name: "operations-430", width: 430, height: 1200 },
  { path: "/settings", name: "settings-desktop", width: 1440, height: 1400 },
  { path: "/settings", name: "settings-768", width: 768, height: 1200 },
];
for (const shot of shots) {
  const context = await browser.newContext({ viewport: { width: shot.width, height: shot.height }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}${shot.path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(6500);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    await page.screenshot({ path: `${OUT}/${shot.name}.png`, fullPage: false });
    console.log(`${shot.name}: overflow=${overflow}`);
  } catch (error) {
    console.log(`${shot.name}: ERROR ${error.message}`);
  } finally {
    await context.close();
  }
}
await browser.close();
