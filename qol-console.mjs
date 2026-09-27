import { chromium } from "playwright-core";
const browser = await chromium.connectOverCDP("http://[::1]:9222");
const context = browser.contexts()[0] ?? (await browser.newContext());
const page = await context.newPage();
const msgs = [];
page.on("console", (m) => msgs.push(`[${m.type()}] ${m.text().slice(0, 160)}`));
await page.goto("http://192.168.1.2:8090/docker", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
// Interactiviteit bewijzen via een puur DOM-effect: klik op de zoekinput en type
const search = page.getByPlaceholder("Search name, image, project…");
await search.click();
await search.type("plex");
await page.waitForTimeout(500);
const rows = await page.locator("table tbody tr").count().catch(() => -1);
console.log("zoektyping werkt, rijen na filter:", rows);
console.log("console-berichten:");
for (const m of msgs.slice(0, 12)) console.log(" ", m);
await page.close();
process.exit(0);
