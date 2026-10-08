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

async function shoot(page, url, file, viewport = { width: 1440, height: 940 }, fullPage = false) {
  await page.setViewportSize(viewport);
  await page.goto(`${BASE}${url}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/${file}`, fullPage });
  console.log("saved", file);
}

const page = await browser.newPage();
await shoot(page, "/", "overview-v150.png");
await shoot(page, "/incidents", "incident-center-v150.png");
// incident detail: use the first active incident id
const res = await fetch(`${BASE}/api/incidents`);
const payload = await res.json();
const first = payload.active[0];
if (first) {
  await shoot(page, `/incidents/${encodeURIComponent(first.id)}`, "incident-detail-v150.png", { width: 1440, height: 940 }, true);
}
/* diagnostics: element-level clip (section taller than viewport) */
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
{
  const heading = page.getByText("Source diagnostics", { exact: false }).first();
  const box = await heading.evaluate((el) => {
    let node = el;
    for (let i = 0; i < 8 && node; i++) {
      node = node.parentElement;
      if (node && node.className && String(node.className).includes("rounded")) break;
    }
    const rect = (node ?? el).getBoundingClientRect();
    return { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y + window.scrollY - 8), width: rect.width + 16, height: rect.height + 16 };
  });
  await page.screenshot({ path: `${OUT}/diagnostics-v150.png`, fullPage: true, clip: box });
  console.log("saved diagnostics-v150.png");
}
await shoot(page, "/incidents", "incident-center-mobile-v150.png", { width: 390, height: 844 });
await shoot(page, "/", "overview-mobile-v150.png", { width: 390, height: 844 });
await browser.close();
console.log("done");
