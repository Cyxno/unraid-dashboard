# Beacon v1.3.19

> Operator note (release hygiene): GitHub currently marks the historic
> **v1.3.5** release as "Latest" because v1.3.6–v1.3.18 were published as
> tags only. After publishing this release (tag `v1.3.19`, non-prerelease,
> marked latest), `/releases/latest` points here. Optionally add a one-line
> notice to the historic v1.3.5 release: "Superseded by Beacon v1.3.19 — see
> the latest release." The v1.3.5 tag and its notes stay untouched.

## Highlights

- **iPhone/iOS PWA Web Push reliability fix**: the whole device push pipeline
  (permission → service worker → subscription → server registration) now
  runs through one tested push-client module. The service worker is resolved
  via an explicit `/sw.js` registration (never the indefinitely-hangable
  `navigator.serviceWorker.ready`), revalidates with `updateViaCache: "none"`,
  and the VAPID key is decoded with base64url tolerance and hard 65-byte
  P-256 validation before subscribing.
- **Service worker hardening**: a push event can never be silently dropped —
  malformed or empty payloads render a generic fallback notification;
  notifications use `renotify` and are audible by default; deep links are
  absolute URLs (a relative `clients.openWindow()` target used to be
  rejected, leaving notification taps dead).
- **Device push diagnostics** in Settings → Notifications: worker
  active/waiting state, worker build version (via a GET_VERSION handshake),
  subscription presence on the device, and whether the server actually knows
  that subscription — with a "Repair this device" re-registration flow.
- **Honest delivery terminology**: test notifications carry a trace id, show
  the subscribed-device count, and distinguish provider acceptance
  (`provider_accepted`) from confirmed on-device display.

## Since v1.3.5 (production highlights)

- Container CPU/memory migrated to cAdvisor; the 15s `docker stats` textfile
  collector retired.
- Helper inventory pipeline hardened (NDJSON parsing, short/full id join,
  chunked inspects, no silent metadata loss).
- Stopped containers are a state, never a problem; unhealthy remains a
  problem.
- Canonical Docker update state: badges, counters, filters and the update
  summary are one consistent truth; GHCR semver tags are immutable
  (main/latest builds publish `:latest` and `:sha-` only).
- Release pipeline hardening: runtime smokes, image boot smokes, contract
  tests and published-artifact verification gate every release.

## Install / update

Images:

```
ghcr.io/cyxno/unraid-dashboard:1.3.19
ghcr.io/cyxno/unraid-dashboard-helper:1.3.19
ghcr.io/cyxno/unraid-dashboard:latest
ghcr.io/cyxno/unraid-dashboard-helper:latest
```

Existing installs: Settings → Updates, or your documented update flow.
Then re-run the push enable/repair flow on each device:
Settings → Notifications → "Repair this device".

## Known issue (v1.3.19)

The `unraid-dashboard-helper:1.3.19` image on GHCR carries a stale
`org.opencontainers.image.version` label (`1.3.18`) due to a build-cache
scope bug (fixed for all future releases). The helper **code** in that image
is correct (helper `/health` reports 1.3.19). The production helper was
deliberately NOT updated to the mislabeled image; the label fix ships in the
next helper release.

## Full changelog

See CHANGELOG.md in the repository.
