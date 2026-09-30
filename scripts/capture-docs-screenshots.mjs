#!/usr/bin/env node
/**
 * Capture curated docs screenshots into docs/screenshots/.
 *
 * Run against a LOCAL instance serving demo/synthetic data (never against
 * a production host — see docs/INSTALL.md "Demo mode"):
 *
 *   PORT=3200 UNRAID_URL=http://127.0.0.1:1 UNRAID_API_KEY=<32 placeholder> \
 *   AUTH_MODE=disabled npx next start -p 3200 &
 *   node scripts/capture-docs-screenshots.mjs http://127.0.0.1:3200
 *
 * Demo payloads are synthetic and clearly badged ("Demo data") in-app, so
 * no real hostnames, IPs or tokens can leak into public screenshots.
 */

import playwright from "playwright-core";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(root, "docs", "screenshots");
const BASE = process.argv[2] ?? "http://127.0.0.1:3200";
const CDP = process.env.CDP ?? "http://127.0.0.1:9223";

const SHOTS = [
  { file: "overview-desktop.png", path: "/", width: 1440, height: 900, fullPage: true },
  { file: "overview-mobile.png", path: "/", width: 390, height: 844, fullPage: true, mobile: true },
  { file: "docker-desktop.png", path: "/docker", width: 1440, height: 900, fullPage: true },
  { file: "docker-mobile.png", path: "/docker", width: 390, height: 844, fullPage: true, mobile: true },
  { file: "storage.png", path: "/storage", width: 1440, height: 900, fullPage: true },
  { file: "system-thermal.png", path: "/system", width: 1440, height: 900, fullPage: true },
  { file: "automation.png", path: "/automation", width: 1440, height: 900, fullPage: true },
  { file: "settings.png", path: "/settings", width: 1440, height: 900, fullPage: true },
  { file: "noc.png", path: "/noc", width: 1920, height: 1080, fullPage: false },
];

mkdirSync(OUT, { recursive: true });
const browser = await playwright.chromium.connectOverCDP(CDP);
for (const shot of SHOTS) {
  const ctx = await browser.newContext({
    viewport: { width: shot.width, height: shot.height },
    deviceScaleFactor: 2,
    isMobile: Boolean(shot.mobile),
    hasTouch: Boolean(shot.mobile),
  });
  const page = await ctx.newPage();
  await page.goto(`${BASE}${shot.path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);
  try {
    await page.screenshot({ path: path.join(OUT, shot.file), fullPage: shot.fullPage, timeout: 20_000, animations: "disabled" });
  } catch {
    // Some demo pages keep a font/poll pending — settle for a viewport shot.
    await page.screenshot({ path: path.join(OUT, shot.file), fullPage: false, timeout: 20_000, animations: "disabled" });
  }
  console.log(`captured docs/screenshots/${shot.file}`);
  await ctx.close();
}
await browser.close();
console.log("done — review captures before committing (no real data policy: docs/PWA.md, README).");
