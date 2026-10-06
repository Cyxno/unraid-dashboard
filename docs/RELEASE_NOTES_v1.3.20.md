# Beacon v1.3.20

Closing release of the v1.3.x line — aligns dashboard and helper versions,
fixes the helper release-provenance bug, and ships the standby-friendly
Unraid API polling work.

## Highlights

- **Consistent release provenance**: dashboard and helper are both 1.3.20;
  helper images now bake exact version/revision/channel labels in-image and
  the build caches are version-scoped so a release can never reuse stale
  metadata from a previous one.
- **Standby-friendly Unraid API polling**: temperature/SMART collection is
  decoupled from realtime metrics (own 15-minute TTL provider), realtime
  metrics poll 5s, array/storage 60s. Measured unraid-api CPU dropped from
  ~14% to ~4–5% of one core on an idle server, GraphQL max latency from ~6s
  to ~0.3s, and standby array disks stay in standby across poll cycles.
- **iOS/PWA Web Push pipeline** (from v1.3.19): one tested push-client
  module, explicit /sw.js registration, validated VAPID decoding, service
  worker build/version handshake, fallback notifications for malformed
  payloads, absolute deep links, and device push diagnostics with a
  "Repair this device" flow in Settings → Notifications.
- **Honest delivery semantics**: test notifications carry a trace id and
  distinguish provider acceptance from on-device display.

## Since v1.3.5 (production highlights)

- cAdvisor is the canonical container CPU/memory source; the 15s
  `docker stats` textfile collector is retired.
- Helper inventory pipeline hardened: NDJSON parsing, short/full id join,
  chunked inspects, no silent metadata loss.
- Stopped containers are a state, never a problem; unhealthy stays a problem.
- Canonical Docker update state: badges, counters, filters and summary are
  one consistent truth.
- Release pipeline hardening: runtime smokes, image boot smokes, contract
  tests, published-artifact verification, immutable GHCR semver tags
  (main/latest builds publish `:latest` and `:sha-` only).

## Install / update

Images:

```
ghcr.io/cyxno/unraid-dashboard:1.3.20
ghcr.io/cyxno/unraid-dashboard:latest
ghcr.io/cyxno/unraid-dashboard-helper:1.3.20*
ghcr.io/cyxno/unraid-dashboard-helper:latest
```

Existing installs: Settings → Updates, or your documented update flow.

\* Note on the helper semver tag: the `unraid-dashboard-helper:1.3.20` tag on
GHCR was built from the commit **before** the version-source alignment, so
its OCI version label reads `1.3.18` while the code is the 1.3.20 helper.
The deploy precheck correctly blocks that artifact. The production helper
runs the correct 1.3.20 code (built from the aligned commit, verified by
`/health` and OCI labels). Do not overwrite the tag; the next helper release
carries clean labels end-to-end.
