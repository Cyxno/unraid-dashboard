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

const VERSION = "v0.9.6";
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
