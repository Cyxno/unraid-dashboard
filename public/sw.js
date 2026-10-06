/*
 * Unraid Dashboard service worker — conservative app-shell resilience.
 *
 * Strategy (documented in README):
 * - Precache the navigation shell ("/") and bundled static assets.
 * - Runtime-cache immutable /_next/static chunks (cache-first) and
 *   bundled icons/fonts.
 * - Navigations: network-first; when the network is unavailable, serve
 *   the cached shell. The app itself renders a clear OFFLINE banner and
 *   labels all data as stale — the shell never pretends to be live.
 * - /api/*: NEVER cached — not for success, not for failures. Live API
 *   data, SSE, actions and audit state must always hit the network.
 * - Non-GET requests: never intercepted, never cached, never replayed.
 *
 * Updates: a new worker waits in "installed" state until the app sends
 * SKIP_WAITING (user-confirmed refresh), so users are never surprised
 * mid-action by a version flip.
 */

const VERSION = "v1.3.20";
/** Build identity for the SW version handshake (GET_VERSION postMessage).
 *  The server injects the git revision at build time when available. */
const BEACON_SW_REVISION = "dev";
const BEACON_SW_VERSION = `${VERSION}+${BEACON_SW_REVISION === "__GIT_SHA__" ? "dev" : BEACON_SW_REVISION.slice(0, 7)}`;
const SHELL_CACHE = `unraid-dash-shell-${VERSION}`;
const STATIC_CACHE = `unraid-dash-static-${VERSION}`;

/** Small, bundler-independent precache list. Hashed assets are runtime-cached. */
const PRECACHE_URLS = [
  "/",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-192.png",
  "/icons/icon-maskable-512.png",
  "/icons/apple-touch-icon.png",
  "/favicon-96.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // cache:'reload' bypasses the HTTP cache so the shell is fresh.
      await Promise.allSettled(
        PRECACHE_URLS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })),
        ),
      );
      // Wait for user-confirmed activation (see SKIP_WAITING handler).
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous versions.
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) =>
              name.startsWith("unraid-dash-") &&
              name !== SHELL_CACHE &&
              name !== STATIC_CACHE,
          )
          .map((name) => caches.delete(name)),
      );
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.disable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  // Fase 4: worker build/version handshake so client diagnostics can show
  // exactly which worker owns push on this device.
  const data = event.data || null;
  if (data && data.type === "GET_VERSION" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ type: "VERSION", version: BEACON_SW_VERSION });
  }
});

/** True for app-owned static assets that are safe to cache. */
function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/favicon-96.png" ||
    url.pathname === "/favicon.ico" ||
    url.pathname === "/manifest.webmanifest" ||
    /\.(css|js|woff2?|png|svg|ico)$/.test(url.pathname)
  );
}

/** Keep the runtime cache bounded (hashed chunks accumulate across deploys). */
async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > maxEntries) {
    for (const key of keys.slice(0, keys.length - maxEntries)) {
      await cache.delete(key);
    }
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only GET is ever cacheable. Everything else (actions, POSTs) passes
  // straight through — the worker never stores or replays writes.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Other origins: ignore (no caching, no interception).
  if (url.origin !== self.location.origin) return;

  // Live data must never be served from cache — not even as fallback.
  // An offline API request fails visibly so the UI can label state.
  if (url.pathname.startsWith("/api/")) return;

  // Navigations: network-first with an offline shell fallback.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          return await fetch(request);
        } catch {
          const cache = await caches.open(SHELL_CACHE);
          const shell = (await cache.match("/")) ?? (await cache.match(request.url));
          if (shell) {
            return shell;
          }
          return new Response(
            "<!doctype html><html><body style='background:#1c1c22;color:#ededf0;font-family:system-ui;display:grid;place-items:center;height:100vh'><p>Offline and no cached shell available.</p></body></html>",
            { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
          );
        }
      })(),
    );
    return;
  }

  // Immutable hashed assets: cache-first.
  if (isStaticAsset(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match(request);
        if (cached) return cached;
        try {
          const response = await fetch(request);
          if (response.ok) {
            await cache.put(request, response.clone());
            void trimCache(STATIC_CACHE, 120);
          }
          return response;
        } catch {
          if (cached) return cached;
          throw new Error("offline and not cached");
        }
      })(),
    );
  }
});

/* ---------------------------------------------------------------------------
 * Web Push notifications (v1.2.0).
 *
 * The server pushes JSON payloads {title, body, tag, url, severity}. The
 * tag (= event fingerprint) lets the OS replace superseded notifications
 * instead of stacking duplicates. Clicking focuses/opens Beacon on the
 * event's deep link. Payloads are plain text rendered by the OS — never
 * HTML — and are truncated server-side.
 * ------------------------------------------------------------------------ */
self.addEventListener("push", (event) => {
  // Fase 13 (v1.3.19): a push event must NEVER be silently dropped. Valid
  // payloads render their fields; malformed/empty payloads render a generic
  // fallback notification so delivery stays visible on the device.
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  const title =
    payload && typeof payload.title === "string" && payload.title.trim()
      ? payload.title.slice(0, 90)
      : "Beacon";
  const body =
    payload && typeof payload.body === "string"
      ? payload.body.slice(0, 220)
      : payload
        ? "Notification received (payload could not be parsed)."
        : "Notification received.";
  const url =
    payload && typeof payload.url === "string" && payload.url.startsWith("/") ? payload.url : "/";
  const tag =
    payload && typeof payload.tag === "string" && payload.tag ? payload.tag.slice(0, 160) : "beacon";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      // iOS/Safari: replace superseded notifications instead of stacking.
      renotify: true,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-maskable-192.png",
      silent: false,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data && typeof event.notification.data.url === "string"
    ? event.notification.data.url
    : "/";
  // clients.openWindow requires an ABSOLUTE URL — a relative deep link is
  // rejected by the browser and the tap would do nothing (v1.3.19).
  const absolute = new URL(target, self.location.origin).href;
  const targetPath = new URL(absolute).pathname;
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientList) {
        const path = new URL(client.url).pathname;
        if (path === targetPath || path === "/") {
          await client.focus();
          if (path !== targetPath) await client.navigate(targetPath).catch(() => {});
          return;
        }
      }
      await self.clients.openWindow(absolute);
    })(),
  );
});
