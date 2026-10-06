# Beacon v1.3.21

Final consolidation release of the v1.3.x line: dashboard and helper are
version-aligned, release provenance is clean end-to-end, and the iOS
background-push repair path is complete.

## Highlights

- **Reliable iPhone background Web Push**: "Repair this device" now ensures
  the ACTIVE service worker is the current build (asks a waiting worker to
  skip waiting and waits for activation) and then recreates the push
  subscription — a stale subscription from an older worker keeps
  background/closed delivery broken on iOS even when the foreground
  (in-app) path works.
- **Unified dashboard/helper release provenance**: both images bake exact
  version/revision/channel labels in-image, build caches are version-scoped,
  and the publish gates assert RAW label equality (no trimming).
- **Reduced Unraid API polling overhead**: temperature/SMART decoupled from
  realtime metrics (15-minute TTL), realtime metrics 5s, array/storage 60s.
  Measured unraid-api CPU ~14% → ~3.5% of one core on an idle server.
- **Service worker push telemetry**: push events received, last push
  timestamp and showNotification failures exposed via the worker version
  handshake (no payloads stored).

## Since v1.3.5 (production highlights)

- cAdvisor is the canonical container CPU/memory source; the 15s
  `docker stats` collector is retired.
- Helper inventory pipeline hardened (NDJSON parsing, short/full id join,
  chunked inspects, no silent metadata loss).
- Stopped containers are a state, never a problem; unhealthy stays a problem.
- Canonical Docker update state; immutable GHCR semver tags.
- Release pipeline hardening: runtime/image/published-artifact gates.
- Standby-friendly Unraid API polling with bounded timeouts and no retry
  storms.

## Install / update

```
ghcr.io/cyxno/unraid-dashboard:1.3.21
ghcr.io/cyxno/unraid-dashboard-helper:1.3.21
ghcr.io/cyxno/unraid-dashboard:latest
ghcr.io/cyxno/unraid-dashboard-helper:latest
```

Existing installs: Settings → Updates, then Settings → Notifications →
"Repair this device" on each push device.

---

## Note on the historic v1.3.5 release

The GitHub release object "Beacon v1.3.5" is historic and stays untouched
(tag, notes, assets). If your repository page still shows it as "Latest",
create the v1.3.21 release object from tag `v1.3.21` (see
`docs/RELEASE_NOTES_v1.3.21.md`) and mark it Latest — or optionally add a
one-line notice to the v1.3.5 release: "Superseded by Beacon v1.3.21 — see
the latest release."
