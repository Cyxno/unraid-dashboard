/* Browser validation for v0.6 (§45/§46): PWA, offline shell, layouts. */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const BASE = "http://127.0.0.1:8095";
const SHOTS = "/tmp/bval/shots";
mkdirSync(SHOTS, { recursive: true });

const results = [];
const consoleErrors = [];

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

let browser = await chromium.connectOverCDP("http://[::1]:9222");

async function reconnect() {
  browser = await chromium.connectOverCDP("http://[::1]:9222");
}

async function newPage(width, height) {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`${page.url()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(`${page.url()}: ${error.message}`));
  return page;
}

async function withPage(width, height, label, fn) {
  try {
    const page = await newPage(width, height);
    await fn(page);
    await page.close();
  } catch (error) {
    record(`${label} (page crashed)`, false, error.message.slice(0, 120));
    await reconnect().catch(() => {});
  }
}

async function overflowCheck(page, label) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollW: doc.scrollWidth, clientW: doc.clientWidth };
  });
  record(`no horizontal overflow: ${label}`, overflow.scrollW <= overflow.clientW + 1, `scrollW=${overflow.scrollW} clientW=${overflow.clientW}`);
}

/* ---- 1. Desktop: PWA registration + shell ---- */
await withPage(1440, 900, "desktop PWA", async (page) => {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const manifestHref = await page.evaluate(() => document.querySelector('link[rel="manifest"]')?.href ?? null);
  record("manifest linked", manifestHref?.includes("/manifest.webmanifest"), manifestHref ?? "missing");

  const swState = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return "unsupported";
    const reg = await navigator.serviceWorker.ready;
    return reg.active ? "active" : "no-active";
  });
  record("service worker active", swState === "active", swState);

  const themeColor = await page.evaluate(() => document.querySelector('meta[name="theme-color"]')?.content ?? null);
  record("theme-color meta", themeColor === "#1c1c22", themeColor ?? "missing");

  const appleTouch = await page.evaluate(() => document.querySelector('link[rel="apple-touch-icon"]')?.href ?? null);
  record("apple-touch-icon linked", Boolean(appleTouch));

  const manifest = await page.evaluate(async () => (await fetch("/manifest.webmanifest")).json());
  record("manifest fetchable + name", manifest.name === "Unraid Dashboard" && manifest.display === "standalone", manifest.name);

  const swFetch = await page.evaluate(async () => (await fetch("/sw.js")).text());
  record("sw.js served", swFetch.includes("unraid-dash-shell"), `${swFetch.length} bytes`);

  await overflowCheck(page, "desktop overview");
  await page.screenshot({ path: `${SHOTS}/desktop-overview.png` });

  const health = await page.evaluate(async () => (await fetch("/api/health")).status);
  record("api health via page context", health === 200, String(health));
});

/* ---- 2. Mobile 390x844: pages + overflow ---- */
await withPage(390, 844, "mobile suite", async (page) => {
  for (const path of ["/", "/docker", "/system", "/settings"]) {
    await page.goto(BASE + path, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1800);
    await overflowCheck(page, `mobile 390 ${path}`);
  }

  await page.goto(BASE + "/system", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  const tempsTab = page.getByRole("button", { name: "Temps" });
  if (await tempsTab.count()) {
    await tempsTab.first().click();
    await page.waitForTimeout(2500);
    const body = await page.textContent("body");
    record("thermal diagnostics card renders", body.includes("Thermal diagnostics (24h)"));
    record("duration buckets render", body.includes("Time distribution"));
    record("episodes section renders", body.includes("Episodes (sustained"));
    record("correlation section renders", body.includes("Load correlation"));
    await page.screenshot({ path: `${SHOTS}/mobile-390-thermal.png` });
  } else {
    record("temps tab found", false, "no button match");
  }

  await page.goto(BASE + "/settings", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const settingsBody = await page.textContent("body");
  record("install hint present", settingsBody.includes("Install as app"));
  record("shared dashboards card present", settingsBody.includes("Shared dashboards"));
  record("update management note present", settingsBody.includes("Update management"));
  record("diagnostics self metrics present", settingsBody.includes("/app/data volume"));
  await page.screenshot({ path: `${SHOTS}/mobile-390-settings.png` });

  await page.goto(BASE + "/docker", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  await overflowCheck(page, "mobile 390 docker");
  await page.screenshot({ path: `${SHOTS}/mobile-390-docker.png` });
});

/* ---- 2b. Desktop docker search narrows table ---- */
await withPage(1440, 900, "docker search", async (page) => {
  await page.goto(BASE + "/docker", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const search = page.getByPlaceholder("Search name, image, project…");
  record("docker search box present", (await search.count()) === 1);
  await search.fill("nextcloud");
  await page.waitForTimeout(700);
  const rowsAfterSearch = await page.locator("table tbody tr").count();
  record("docker filter narrows", rowsAfterSearch >= 1 && rowsAfterSearch < 10, `${rowsAfterSearch} rows for "nextcloud"`);
});

/* ---- 3. Shared dashboards: create + link page + views menu ---- */
await withPage(1440, 900, "shared dashboards", async (page) => {
  const createResponse = await page.request.post(`${BASE}/api/dashboards`, {
    headers: { origin: BASE },
    data: {
      name: "Browser Validation Board",
      layout: { order: ["docker", "cpu", "memory"], hidden: ["uptime"] },
      preferences: { historyWindow: "1h", density: "compact", dockerFilter: "prom" },
    },
  });
  const created = (await createResponse.json())?.dashboard;
  record("dashboard create via API", createResponse.status() === 201 && Boolean(created?.id), created?.id ?? createResponse.status());

  await page.goto(`${BASE}/dashboard/${created.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  const body = await page.textContent("body");
  record("shared page renders title", body.includes("Browser Validation Board"));
  record("shared page shows owner", body.includes("owner lan"));
  record("shared docker filter applied", body.includes("filter: prom"));
  await overflowCheck(page, "shared dashboard page");
  await page.screenshot({ path: `${SHOTS}/desktop-shared-dashboard.png` });

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /^Views/ }).click();
  await page.waitForTimeout(2500);
  const menuText = await page.textContent("body");
  record("views menu shows Local section", menuText.includes("Local — this browser"));
  record("views menu shows Shared section", menuText.includes("Shared — server"));
  record("shared board listed in menu", menuText.includes("Browser Validation Board"));
  await page.screenshot({ path: `${SHOTS}/desktop-views-menu.png` });
  await page.keyboard.press("Escape");
});

/* ---- 4. NOC + kiosk + auto-cycle ---- */
await withPage(1280, 800, "NOC", async (page) => {
  await page.goto(BASE + "/noc", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  const nocBody = await page.textContent("body");
  record("NOC shows connection state", nocBody.includes("live") || nocBody.includes("connecting"));
  record("NOC shows last update timestamp", /\d{1,2}:\d{2}/.test(nocBody), "HH:MM found");
  record("NOC read-only note", nocBody.includes("read-only by design"));
  await page.screenshot({ path: `${SHOTS}/noc-overview.png` });

  await page.evaluate(() => {
    const prefs = JSON.parse(window.localStorage.getItem("unraid-dashboard.prefs.v1") ?? "{}");
    prefs.nocCycleSeconds = 15;
    window.localStorage.setItem("unraid-dashboard.prefs.v1", JSON.stringify(prefs));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.waitForTimeout(17000);
  const after = await page.textContent("body");
  record("auto-cycle advances panel", after.includes("Docker —"), "panel switched to Docker");
  await page.screenshot({ path: `${SHOTS}/noc-cycled.png` });
  await page.evaluate(() => {
    const prefs = JSON.parse(window.localStorage.getItem("unraid-dashboard.prefs.v1") ?? "{}");
    prefs.nocCycleSeconds = 0;
    window.localStorage.setItem("unraid-dashboard.prefs.v1", JSON.stringify(prefs));
  });
});

await withPage(1024, 768, "kiosk", async (page) => {
  await page.goto(BASE + "/noc?mode=kiosk", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2200);
  const kioskBody = await page.textContent("body");
  record("kiosk page rail present", kioskBody.includes("Containers") && kioskBody.includes("System & Temps"));
  await page.screenshot({ path: `${SHOTS}/kiosk-1024.png` });
  await overflowCheck(page, "kiosk 1024 landscape");
});

/* ---- 5. Offline: shell + banner ---- */
await withPage(390, 844, "offline", async (page) => {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });

  // Navigate while offline first (SW shell fallback), then flip the
  // device-online state the way a real device reports it — a live
  // session losing connectivity, no reload.
  await page.goto(BASE + "/docker", { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    window.dispatchEvent(new Event("offline"));
  });
  await page.waitForTimeout(800);
  const offlineBody = await page.textContent("body").catch(() => "");
  record(
    "offline shell renders",
    offlineBody.includes("Unraid") || offlineBody.includes("Unraid server"),
    offlineBody.slice(0, 60).replace(/\s+/g, " "),
  );
  record("offline banner shows", offlineBody.includes("Offline — showing last known state"));
  await page.screenshot({ path: `${SHOTS}/mobile-offline.png` });
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.detach().catch(() => {});
});

/* ---- 6. iPhone-ish 430x932 + tablet 1024 spot checks ---- */
await withPage(430, 932, "iphone-430", async (page) => {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await overflowCheck(page, "overview 430x932");
  await page.screenshot({ path: `${SHOTS}/iphone-430-overview.png` });
});
await withPage(1024, 1366, "tablet-1024", async (page) => {
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await overflowCheck(page, "overview tablet-1024");
  await page.screenshot({ path: `${SHOTS}/tablet-1024-overview.png` });
});

console.log("\n---- console errors ----");
console.log(consoleErrors.length ? consoleErrors.slice(0, 10).join("\n") : "(none)");
const realErrors = consoleErrors.filter((entry) => !entry.includes("ERR_INTERNET_DISCONNECTED"));
  record("no console/page errors", realErrors.length === 0, `${realErrors.length} real errors (offline-fetch noise excluded)`);

const failed = results.filter((entry) => !entry.ok);
console.log(`\n==== ${results.length - failed.length}/${results.length} checks passed ====`);
if (failed.length) process.exit(1);
process.exit(0);
