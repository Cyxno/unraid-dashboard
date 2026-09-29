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
  { path: "/docker", name: "docker", widths: [390, 430, 1440], themes: ["dark", "light"] },
  { path: "/storage", name: "storage", widths: [390, 1440], themes: ["dark", "light"] },
  { path: "/operations", name: "operations", widths: [1440], themes: THEMES },
  { path: "/settings", name: "settings", widths: [390, 1440], themes: ["dark", "light"] },
  { path: "/noc", name: "noc", widths: [1440], themes: ["dark", "midnight"] },
];

/**
 * Mobile overlay states (v0.9.5): captured at 390 dark on the overview.
 * Each state opens the overlay, asserts it fits INSIDE the viewport
 * (hard gate — this is the "sheet/drawer extends beyond screen" class
 * of bug), then closes it and asserts it is gone (interaction gate).
 */
const OVERLAYS = [
  {
    name: "nav-drawer",
    open: 'button[aria-label="Open navigation"]',
    dialog: 'aside[role="dialog"][aria-label="Navigation"]',
    // Full-viewport scrim: its center sits beneath the drawer, so close
    // at an explicit clear point instead.
    close: 'button[aria-label="Close navigation"]',
    closeAt: { x: 360, y: 300 },
  },
  {
    name: "more-sheet",
    open: 'button[aria-label="More pages"]',
    dialog: 'div[role="dialog"][aria-label="More pages"]',
    close: 'div[role="dialog"][aria-label="More pages"] button[aria-label="Close"]',
    closeAt: null,
  },
];

/** Wait for an app-specific readiness marker per route (data rendered). */
const WAIT_FOR = {
  "/": "text=Uptime",
  "/docker": "text=Containers",
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

  const overlayFailures = await captureOverlays(browser);

  await browser.close();
  console.log(`\n${captures} captures · overflow failures: ${overflowFailures} · diff failures: ${diffFailures} · overlay failures: ${overlayFailures}`);
  process.exit(overflowFailures + diffFailures + overlayFailures > 0 ? 1 : 0);
}

/**
 * Overlay pass (v0.9.5): for every overlay state, open → assert fit inside
 * the viewport + no page overflow → capture → close → assert gone.
 */
async function captureOverlays(browser) {
  let failures = 0;
  for (const overlay of OVERLAYS) {
    const label = `overlay-${overlay.name}-390`;
    const context = await browser.newContext({ viewport: { width: 390, height: 700 } });
    const page = await context.newPage();
    try {
      await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.evaluate(() => {
        localStorage.setItem(
          "beacon.appearance.v1",
          JSON.stringify({ theme: "dark", accent: "emerald", density: "comfortable", motion: "full" }),
        );
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1_500);

      await page.click(overlay.open);
      await page.waitForSelector(overlay.dialog, { timeout: 5_000 });
      await page.waitForTimeout(400);

      const fit = await page.evaluate((selector) => {
        const element = document.querySelector(selector);
        if (!element) return { ok: false, reason: "dialog missing" };
        const box = element.getBoundingClientRect();
        const viewportHeight = window.innerHeight;
        const viewportWidth = window.innerWidth;
        const inside = box.top >= -1 && box.left >= -1 && box.right <= viewportWidth + 1 && box.bottom <= viewportHeight + 1;
        const pageOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
        return {
          ok: inside && !pageOverflow,
          reason: inside
            ? pageOverflow ? "page-level horizontal overflow" : "ok"
            : `box ${JSON.stringify({ top: box.top, left: box.left, right: box.right, bottom: box.bottom })} vs viewport ${viewportWidth}x${viewportHeight}`,
        };
      }, overlay.dialog);
      if (!fit.ok) {
        failures += 1;
        console.error(`FIT FAIL  ${label}: ${fit.reason}`);
      }

      const shot = await page.screenshot();
      writeFileSync(path.join(CAPTURE_DIR, `${label}.png`), shot);

      // Close at an explicit clear point for full-viewport scrims.
      await page.click(overlay.close, overlay.closeAt ? { position: overlay.closeAt } : {});
      const gone = await page.waitForSelector(overlay.dialog, { state: "detached", timeout: 5_000 }).then(() => true).catch(() => false);
      if (!gone) {
        failures += 1;
        console.error(`CLOSE FAIL ${label}: dialog still present after close`);
      }
    } catch (error) {
      failures += 1;
      console.error(`ERROR     ${label}: ${error.message.slice(0, 100)}`);
    } finally {
      await context.close();
    }
  }
  return failures;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
