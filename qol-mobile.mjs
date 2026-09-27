import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://[::1]:9222");
const context = browser.contexts()[0] ?? (await browser.newContext());
const pages = ["/", "/docker", "/storage", "/system", "/settings", "/notifications", "/logs", "/audit", "/vms", "/noc?mode=kiosk"];
const widths = [[320, 700], [360, 800], [375, 812], [390, 844], [430, 932]];
let issues = 0;
for (const [w, h] of widths) {
  const page = await context.newPage();
  await page.setViewportSize({ width: w, height: h });
  for (const path of pages) {
    await page.goto("http://192.168.1.2:8090" + path, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1200);
    const m = await page.evaluate(() => ({ o: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: (document.body.textContent ?? "").length }));
    const ok = m.o <= 1;
    if (!ok) { console.log(`OVERFLOW ${w}x${h} ${path}: +${m.o}px`); issues++; }
  }
  console.log(`${w}x${h}: ${pages.length} pagina's gecheckt`);
  await page.close();
}
console.log("overflow-problemen:", issues);
process.exit(0);
