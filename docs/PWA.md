# PWA & iOS identity

Beacon ships as an installable PWA. This document covers the icon/identity
pipeline and the iOS-specific behavior that has caused confusion before.

## Icon pipeline

- Single source: `public/icon-source.svg` → regenerate all sizes with
  `node scripts/generate-icons.mjs` (sharp). Run it after any brand change.
- Outputs (all opaque — the apple touch icon is composited onto the theme
  background, no alpha):
  - `icons/icon-192.png`, `icons/icon-512.png` (`purpose: any`)
  - `icons/icon-maskable-192.png`, `icons/icon-maskable-512.png`
    (content in the inner 80% safe zone)
  - `icons/apple-touch-icon.png` **and** `/apple-touch-icon.png` — the head
    links the first; the root copy covers launchers that probe the
    documented default path directly.
  - `favicon-96.png`
- `manifest.webmanifest`: name/short_name **Beacon**, `display: standalone`,
  `start_url: /`, theme/background `#161619`, both `any` and `maskable`
  icons, shortcuts for Docker and the NOC wallboard.
- `layout.tsx` metadata: `appleWebApp: { capable: true, statusBarStyle:
  "black-translucent", title: "Beacon" }` renders the iOS meta tags; icon
  links carry a `?v=N` cache-buster.

## iOS icon cache (the "generic letter icon" trap)

iOS caches home-screen icons by URL extremely aggressively and never
re-validates an installed shortcut on its own. If an installed Beacon
shortcut shows a generic letter instead of the lighthouse mark:

1. This is a stale client-side cache, not a manifest failure — the served
   head (`<link rel="apple-touch-icon">`), the PNG (180×180, opaque) and the
   manifest have been verified correct since v0.9.0.
2. Bump the `?v=` suffix on the icon URLs (layout.tsx + manifest) when the
   artwork changes so at least fresh installs never see a stale CDN/proxy
   copy.
3. **Remove the home-screen shortcut and re-add it once** after an icon
   release. This is expected and documented behavior on iOS; do not
   misdiagnose the cached icon as a broken manifest.
4. If Beacon is installed through the reverse proxy (auth path), Safari must
   be able to fetch `/icons/apple-touch-icon.png` with the session it has —
   if the auth provider intercepts that URL with a redirect, iOS falls back
   to the generic icon. Exempt static assets (at minimum the icon paths)
   from the auth redirect in the proxy config if this occurs.

## Startup identity

With `apple-mobile-web-app-capable` + the opaque apple touch icon +
`background_color`, iOS generates the standalone launch screen from the
Beacon mark automatically — no splash asset is shipped.

## iOS real-device checklist (v0.9.9)

Server-side identity is verified correct; what remains is on-device
behavior. Run this once after each icon release:

1. Remove any existing Beacon home-screen shortcut (delete the icon).
2. Close Safari completely (swipe away).
3. Reopen Safari → Beacon (warm cache from the old install must go).
4. Share → **Add to Home Screen** → Add.
5. Verify the home-screen icon shows the **lighthouse mark** (not a letter).
6. Launch Beacon from the home screen.
7. Verify **standalone mode** (no Safari URL/status bar chrome).
8. Verify the top bar respects the notch (safe-area top padding).
9. Verify the bottom nav: opaque, clear of content, safe-area bottom.
10. Open **More** (bottom nav) → sheet fits, scrolls, closes.
11. Open the **sidebar** from the hamburger → fits, closes.
12. Switch a page and a theme → still standalone, no Safari takeover.

Record pass/fail per step. A generic-letter icon at step 5 means the
cache steps (1–3) were skipped or the auth proxy intercepted the icon
fetch (see caveat above).

## iOS install & refresh procedure

- **First install**: open Beacon in Safari → Add to Home Screen.
- **Icon refresh after an icon release**: the `?v=` URL bump only helps
  NEW fetches; an installed shortcut keeps its snapshot. Remove the
  shortcut, force-quit Safari, reopen, re-add. There is no supported
  in-place refresh on iOS.
- **Standalone expectations**: launches full-screen with the Beacon mark
  as the (iOS-generated) launch image on the theme background; status bar
  style black-translucent; safe areas consumed by the shell.

```sh
curl -sI https://<host>/icons/apple-touch-icon.png | head -3   # 200, image/png
curl -s https://<host>/ | grep -o 'apple-touch-icon[^>]*'      # head link with ?v=
curl -s https://<host>/manifest.webmanifest | grep -o '"name"[^,]*'  # "Beacon — ..."
```

## Verifying a deploy

## Push notifications on iOS

Web Push for home-screen-installed web apps is supported from
**iOS 16.4** onward, with these requirements:

- The app must be installed to the home screen (Share → Add to Home
  Screen) — Safari tabs do not receive push on iOS.
- Notification permission must be granted from an explicit user action
  inside the app (Settings → Notifications → Enable notifications);
  Beacon never prompts on page load.
- iOS delivers push to installed PWAs through the standard Web Push
  protocol with the server's VAPID keys — no Firebase/APNs setup is
  needed.
- A **secure context (HTTPS) is required**. Running Beacon privately?
  [Tailscale Serve](TAILSCALE.md) provides a tailnet-only HTTPS origin
  with an automatically provisioned certificate — no public exposure
  needed. If the PWA was installed from an old HTTP origin, remove it
  and reinstall from the HTTPS origin (origins are separate).

Desktop Chrome, Edge and Firefox support both in-tab notifications and
installed-app push. If the server has no VAPID keys configured, Beacon
falls back to in-app toasts and local browser notifications while a tab
is open.
