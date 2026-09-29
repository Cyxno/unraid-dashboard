#!/usr/bin/env node
/**
 * Visual regression + overflow harness (v0.9.1).
 *
 * Usage: node scripts/visual-regression.mjs [--update]
 *
 * Captures the core page matrix (6 pages × themes × widths) with
 * localStorage-driven theme selection against the LIVE production app,
 * then:
 *   1. asserts NO page-level horizontal overflow (scrollWidth > clientWidth)
 *      on every route/breakpoint/theme — hard fail;
 *   2. pixel-compares against baselines in tests/visual-baselines/ with a
 *      coarse perceptual tolerance (downscale to 24×16, per-channel delta)
 *      so antialiasing never trips it — only layout shifts / missing
 *      components / broken themes do. --update re-records baselines.
 *
 * Baselines live OUT of runtime assets (tests/visual-baselines, gitignored
 * by default — baselines are machine-dependent, the harness is the asset).
 * Requires a FRESH headless Chrome on 127.0.0.1:9223 (restart the container
 * before running: connectOverCDP fails if a service-worker target from a
 * previous app visit is registered) and BASE_URL env (default
 * http://127.0.0.1:8090).
 */

import playwright from "playwright-core";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASELINE_DIR = path.join(root, "tests", "visual-baselines");
const CAPTURE_DIR = path.join(root, "tmp-visual");
const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:8090";
const UPDATE = process.argv.includes("--update");

const THEMES = ["dark", "light", "midnight", "ocean"];
const MATRIX = [
  { path: "/", name: "overview", widths: [390, 768, 1440], themes: THEMES },
  { path: "/docker", name: "docker", widths: [390, 1440], themes: ["dark", "light"] },
  { path: "/storage", name: "storage", widths: [390, 1440], themes: ["dark", "light"] },
  { path: "/operations", name: "operations", widths: [1440], themes: THEMES },
  { path: "/settings", name: "settings", widths: [1440], themes: ["dark", "light"] },
  { path: "/noc", name: "noc", widths: [1440], themes: ["dark", "midnight"] },
];

/** Wait for an app-specific readiness marker per route (data rendered). */
const WAIT_FOR = {
  "/": "text=Uptime",
  "/docker": "text=Container updates",
  "/storage": "text=Usable capacity",
  "/operations": "text=Release chain",
  "/settings": "text=Appearance",
  "/noc": "text=ALL SYSTEMS NOMINAL",
};

/** Perceptual downscale-compare: 24×16 grid mean colors, RMS delta. */
async function perceptualDelta(aBuffer, bBuffer) {
  const sharp = (await import("sharp")).default;
  const grid = async (buffer) => {
    const { data, info } = await sharp(buffer).resize(24, 16, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
    return { data, channels: info.channels };
  };
  const A = await grid(aBuffer);
  const B = await grid(bBuffer);
  let sum = 0;
  const count = 24 * 16;
  for (let pixel = 0; pixel < count; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const diff = A.data[pixel * A.channels + channel] - B.data[pixel * B.channels + channel];
      sum += diff * diff;
    }
  }
  return Math.sqrt(sum / (count * 3)); // 0..255 RMS
}

const THRESHOLD_RMS = 24; // coarse: catches layout shifts/theme breakage, not AA noise

async function connectWithRetry(attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await playwright.chromium.connectOverCDP("http://127.0.0.1:9223");
    } catch (error) {
      if (attempt === attempts) throw error;
      console.error(`connect failed (attempt ${attempt}): ${String(error.message).slice(0, 80)} — retrying`);
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
  throw new Error("unreachable");
}

async function main() {
  const browser = await connectWithRetry();
  mkdirSync(CAPTURE_DIR, { recursive: true });
  if (UPDATE) mkdirSync(BASELINE_DIR, { recursive: true });

  let overflowFailures = 0;
  let diffFailures = 0;
  let captures = 0;

  for (const entry of MATRIX) {
    for (const width of entry.widths) {
      for (const theme of entry.themes) {
        const label = `${entry.name}-${theme}-${width}`;
        const context = await browser.newContext({ viewport: { width, height: Math.min(1400, width + 200) } });
        const page = await context.newPage();
        try {
          await page.goto(`${BASE_URL}${entry.path}`, { waitUntil: "domcontentloaded", timeout: 30000 });
          await page.evaluate((t) => {
            localStorage.setItem(
              "beacon.appearance.v1",
              JSON.stringify({ theme: t, accent: "emerald", density: "comfortable", motion: "full" }),
            );
          }, theme);
          await page.reload({ waitUntil: "domcontentloaded" });
          const waitFor = WAIT_FOR[entry.path];
          if (waitFor) await page.waitForSelector(waitFor, { timeout: 45_000 }).catch(() => {});
          await page.waitForTimeout(1_500);

          // Overflow assertion (hard gate).
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
          if (overflow) {
            overflowFailures += 1;
            console.error(`OVERFLOW  ${label}: scrollWidth > clientWidth`);
          }

          const shot = await page.screenshot();
          captures += 1;
          const capturePath = path.join(CAPTURE_DIR, `${label}.png`);
          writeFileSync(capturePath, shot);
          if (UPDATE) writeFileSync(path.join(BASELINE_DIR, `${label}.png`), shot);

          if (!UPDATE) {
            const baselinePath = path.join(BASELINE_DIR, `${label}.png`);
            if (existsSync(baselinePath)) {
              const delta = await perceptualDelta(shot, readFileSync(baselinePath));
              if (delta > THRESHOLD_RMS) {
                diffFailures += 1;
                console.error(`DIFF      ${label}: RMS ${delta.toFixed(1)} > ${THRESHOLD_RMS}`);
              }
            } else {
              console.error(`BASELINE  ${label}: missing (run --update to record)`);
            }
          }
        } catch (error) {
          overflowFailures += 1;
          console.error(`ERROR     ${label}: ${error.message.slice(0, 100)}`);
        } finally {
          await context.close();
        }
      }
    }
  }

  await browser.close();
  console.log(`\n${captures} captures · overflow failures: ${overflowFailures} · diff failures: ${diffFailures}`);
  process.exit(overflowFailures + diffFailures > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
