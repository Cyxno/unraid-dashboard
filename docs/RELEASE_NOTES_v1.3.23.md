# Beacon v1.3.23

Clean baseline release that closes the v1.3.x line: dashboard and helper
release provenance is fully aligned and the GitHub release page is
re-established as the single source of truth for releases.

## Highlights

- **Clean v1.3.x baseline**: dashboard and helper are both 1.3.23 with exact
  matching OCI provenance (version / channel `release` / identical revision)
  on their semver images.
- **Release hygiene**: the v1.3.x history is summarized in one place; known
  historical artifact quirks are documented transparently below.
- No functional changes — this release exists to close the v1.3.x line on a
  verified, coherent baseline.

## Since the historic v1.3.5 GitHub release

Production highlights shipped across v1.3.6 → v1.3.22 (tags; most without a
GitHub release object until now):

- cAdvisor as the canonical container CPU/memory source; the 15s
  `docker stats` collector retired.
- Standby-friendly Unraid API polling: temperature/SMART decoupled
  (15-minute TTL), realtime metrics 5s, array/storage 60s — unraid-api CPU
  ~14% → ~3.5% of one core, GraphQL max latency ~6s → ~0.3s.
- Helper inventory pipeline hardened: NDJSON parsing, short/full id join,
  chunked inspects, last-known-good semantics.
- Stopped containers are a state, never a problem; unhealthy stays a problem.
- Canonical Docker update state: badges, counters, filters and summary are
  one consistent truth; GHCR semver tags are immutable.
- iOS/PWA Web Push state model: permission, subscription, server
  registration and delivery are separate dimensions; device repair flow and
  service worker push telemetry.
- Release pipeline hardening: runtime smokes, image boot smokes, RAW
  provenance assertions, version-scoped build caches and published-artifact
  verification on every release.

## Install / update

```
ghcr.io/cyxno/unraid-dashboard:1.3.23
ghcr.io/cyxno/unraid-dashboard-helper:1.3.23
ghcr.io/cyxno/unraid-dashboard:latest
ghcr.io/cyxno/unraid-dashboard-helper:latest
```

Existing installs: Settings → Updates, or your documented update flow.

## Known historical artifacts (transparent)

- `unraid-dashboard-helper:1.3.20` on GHCR carries a stale `1.3.18` version
  label (pre-alignment build; build-cache scope bug, since fixed). The tag
  stays immutable — do not use it; use `1.3.23` or `latest`.
- `unraid-dashboard-helper:1.3.19`'s helper deploy was skipped for the same
  class of reason; `1.3.23` supersedes it.
