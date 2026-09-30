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

## Verifying a deploy

```sh
curl -sI https://<host>/icons/apple-touch-icon.png | head -3   # 200, image/png
curl -s https://<host>/ | grep -o 'apple-touch-icon[^>]*'      # head link with ?v=
curl -s https://<host>/manifest.webmanifest | grep -o '"name"[^,]*'  # "Beacon — ..."
```
