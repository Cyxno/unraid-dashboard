import playwright from "playwright-core";

const BASE = "http://127.0.0.1:8099";
const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewportSize({ width: 1440, height: 1000 });
await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);

const heading = page.getByText("Source diagnostics", { exact: false }).first();
const box = await heading.evaluate((el) => {
  // Climb to the enclosing card (rounded border container).
  let node = el;
  for (let i = 0; i < 8 && node; i++) {
    node = node.parentElement;
    if (node && node.className && String(node.className).includes("rounded")) break;
  }
  const rect = (node ?? el).getBoundingClientRect();
  return { x: Math.max(0, rect.x - 8), y: Math.max(0, rect.y + window.scrollY - 8), width: rect.width + 16, height: rect.height + 16 };
});
await page.screenshot({ path: "docs/screenshots/diagnostics-v150.png", fullPage: true, clip: box });
console.log("saved", JSON.stringify(box));
await browser.close();
