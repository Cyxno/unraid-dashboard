# Beacon v1.0.0 / v1.0.1 release notes

> v1.0.1 is a follow-up to v1.0.0: it fixes the service-worker version stamp
> (tag-built images baked the package.json version instead of the tag
> version). Deployed v1.0.0 instances should update; fresh installs can
> start at 1.0.1 directly.

## What Beacon is

Beacon is a self-hosted, dark-first operations dashboard for Unraid servers:
Docker operations with verified lifecycle actions, storage, system and
thermal intelligence, opt-in automation, an update manager with registry
digest verification, a read-only machine API, and an installable PWA —
behind a backend-for-frontend that keeps every credential server-side.

## Major capabilities in 1.0

- **Operations-first Docker page** — searchable/filterable container list
  with live metrics, one-click section navigation (Updates · Projects ·
  History, lazy-loaded), and **Start/Stop with confirmed, SSE-verified
  transitions**, audit-logged.
- **Thermal intelligence** — 24h analysis and 7-day context (averages,
  week-over-week delta, data coverage, sustained hot episodes with
  load/power correlation and top-consumer attribution, idle-hot detection).
- **Update manager** — strict remote pulls from GHCR with digest
  verification ("Registry verified"), rollback, persisted history.
- **Capability-aware automation** — opt-in pilot auto-updates with proven
  rollback; per-workflow eligibility with specific blockers; pipeline-owned
  projects protected.
- **Agent API v1** — read-only machine interface (optional bearer token).
- **Mobile-first PWA** — installable, safe-area aware, offline shell, 8
  themes + accents, NOC wallboard mode.

## Installation

docs/INSTALL.md — prerequisites, DockerMan template or `docker run`, API
keys, Prometheus, update helper, reverse proxy.

## Upgrading from 0.9.x

docs/V1_UPGRADE.md — no breaking data changes; the data volume is
bidirectionally compatible with v0.9.16 (verified both directions). Update
in-app (helper) or host-side; automatic rollback on failed health checks.

## Security model

docs/SECURITY.md — secrets never reach the browser; the main app has no
Docker socket (the isolated helper is the only Docker-socket component);
lifecycle actions need a separate `DOCKER: UPDATE_ANY` key and are
cooldown/rate-limited and audited; Agent API is read-only by construction;
updates verify digests and refuse local substitutions.

## Known limitations

- **Docker restart is not offered** — the verified Unraid API exposes no
  restart mutation; Beacon will not emulate one.
- **iOS real-device QA** is operator-dependent; the 12-step checklist is in
  docs/PWA.md (server-side identity is complete and verified).
- **VM power actions** are read-only by design.

## Verification (production deploy)

- version route / diagnostics / image label: 1.0.1
- service worker: v1.0.1
- `digestMatch: true`, `requireRemote: true`, provenance badge
  **Registry verified**
- rollback reference: previous tag image retained as
  `unraid-dashboard:previous`
