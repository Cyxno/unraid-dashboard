import playwright from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:8099";
const OUT = "docs/screenshots";
mkdirSync(OUT, { recursive: true });

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ["--no-sandbox"],
});

const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 940 });

/* Insights overview */
await page.goto(`${BASE}/insights`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/insights-v160.png`, fullPage: true });
console.log("saved insights-v160.png");

/* Storage forecast section: clip the Capacity card */
const capacityHeading = page.getByText("Capacity", { exact: true }).first();
await capacityHeading.scrollIntoViewIfNeeded();
await page.waitForTimeout(800);
const box = await capacityHeading.evaluate((el) => {
  let node = el;
  for (let i = 0; i < 8 && node; i++) {
    node = node.parentElement;
    if (node && node.className && String(node.className).includes("rounded")) break;
  }
  const rect = (node ?? el).getBoundingClientRect();
  return { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y + window.scrollY - 8), width: rect.width + 16, height: rect.height + 16 };
});
await page.screenshot({ path: `${OUT}/storage-forecast-v160.png`, fullPage: true, clip: box });
console.log("saved storage-forecast-v160.png");

/* Container history (demo-app detail: operational history card) */
await page.goto(`${BASE}/docker/demo-app`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
const historyHeading = page.getByText("Operational history", { exact: false }).first();
if ((await historyHeading.count()) > 0) {
  await historyHeading.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  const hbox = await historyHeading.evaluate((el) => {
    let node = el;
    for (let i = 0; i < 8 && node; i++) {
      node = node.parentElement;
      if (node && node.className && String(node.className).includes("rounded")) break;
    }
    const rect = (node ?? el).getBoundingClientRect();
    return { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y + window.scrollY - 8), width: rect.width + 16, height: rect.height + 16 };
  });
  await page.screenshot({ path: `${OUT}/container-history-v160.png`, fullPage: true, clip: hbox });
} else {
  await page.screenshot({ path: `${OUT}/container-history-v160.png`, fullPage: true });
}
console.log("saved container-history-v160.png");

/* Mobile insights */
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/insights`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/insights-mobile-v160.png`, fullPage: true });
console.log("saved insights-mobile-v160.png");

await browser.close();
console.log("done");
