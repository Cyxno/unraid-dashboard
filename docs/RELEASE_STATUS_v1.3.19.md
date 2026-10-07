# v1.3.x release status

> **Update (v1.3.24):** the Web Push registration pipeline is now fully
> traceable. Every Enable/Repair attempt produces an 18-step PASS/FAIL/NOT_REACHED
> trace (permission → worker → subscribe → server POST → server reread →
> canonical ready), rendered in Settings → Notifications. The recreate flow no
> longer treats a briefly-visible stale subscription as a hard failure. Both
> production containers run authentic semver release artifacts (1.3.24).
> The physical iPhone acceptance (5/5 native notifications incl. background and
> closed-PWA) remains the final operator step — after "Enable Web Push" /
> "Repair Web Push" succeeds on-device (server reread + fingerprint match are
> hard-gated), send Web Push tests via Settings and confirm the native
> notifications.

# v1.3.19 release status (open items)

Release `v1.3.19` is published (tag, gated CI + publish runs, dashboard
deployed and healthy) but is **not fully closed**. Three items remain; all
three require the operator (device access and/or GitHub credentials that are
not available on the production host).

## Open item 1 — physical iPhone acceptance (the acceptance test)

On the iPhone:

1. Fully close and reopen the Beacon PWA (activates service worker
   `v1.3.19+<sha>`).
2. Settings → Notifications → check the **"This device (push pipeline)"**
   block: worker active, worker version `v1.3.19+…`, subscription present,
   "Server knows subscription: yes".
3. If it reads "Server knows subscription: NO — mismatch" or "Server
   registered devices: none": press **"Repair this device"**.
4. Send **Test notification** three times: PWA open → PWA background → PWA
   closed. Each response carries a `traceId` and `subscribedDevices ≥ 1`;
   each attempt should render a native notification.
5. Tap a notification → Beacon must focus/open on the deep link.

Report the results back; the server-side evidence (subscription present,
provider acceptance, history entry) will be verified against them.

## Open item 2 — GitHub Release object (and the "Latest: v1.3.5" UI)

v1.3.6–v1.3.19 exist as **tags only**; the newest GitHub *release object* is
the historic `v1.3.5`, so the repo page and `/releases/latest` still point
there. Creating the `v1.3.19` release object needs a GitHub token or a
one-time UI action (no token on this host):

- Releases → **Draft new release** → tag `v1.3.19` → title "Beacon v1.3.19"
  → paste `docs/RELEASE_NOTES_v1.3.19.md` → mark as latest.
- Optional notice on the historic v1.3.5 release: "Superseded by Beacon
  v1.3.19 — see the latest release." (tag and notes stay untouched).

The README badge/link already follow `/releases/latest` dynamically.

## Open item 3 — helper image label (informational)

The published `unraid-dashboard-helper:1.3.19` image carries a stale
`org.opencontainers.image.version` label (`1.3.18`) caused by a shared GHA
build-cache scope (fixed on `main`: version-scoped caches). The deploy
precheck therefore blocks that tag, and the production helper intentionally
keeps running **1.3.18** — functionally identical for push (the push fix
lives in the dashboard + service worker). Next helper release will carry
clean labels; do NOT overwrite the `:1.3.19` tag.

## What is already verified

- Dashboard 1.3.19 live and healthy (`channel: release`, SHA `f7a741b`).
- Helper 1.3.18 healthy; inventory pipeline healthy; 0 refresh failures.
- VAPID keys present and structurally valid (65-byte P-256, pair verified).
- Push diagnostics + repair UI shipped in this build (SSR chunks verified).
- 843+ tests green, lint 0/0, typecheck, production build green.
- 30-minute post-deploy stability green.
