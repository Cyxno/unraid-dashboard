# v1.0.0-rc1 release notes

## Highlights

- **Stabilization milestone.** The 0.9.x feature set is frozen: Docker
  operations with production-proven Start/Stop, storage, system + thermal
  intelligence, capability-aware automation, update manager with digest
  verification, read-only Agent API, installable PWA, mobile-first shells.
- **Layout flow fixed at the architectural level**: independent column stacks
  (no row-coupled dead bands), balanced Settings columns (production-measured
  83px difference), one-click Docker section navigation with settled-position
  scrolling, enforced by hard layout gates in the visual harness.
- **Prerelease support in the update pipeline**: semver release candidates
  (`1.0.0-rc1 < 1.0.0`) order correctly through the helper and in-app
  updater.

## Architecture

Next.js BFF (no Docker socket) → Unraid GraphQL (read-only key) → Prometheus
(read-only) → isolated update helper (only Docker-socket component) → GHCR
(digest-verified updates). SSE accelerates polling; every mutation is
confirmed, guarded and audited. Details: docs/ARCHITECTURE.md.

## Installation

docs/INSTALL.md — DockerMan template or `docker run`; read-only API key only
for the full dashboard experience.

## Upgrade from 0.9.x

docs/V1_UPGRADE.md — no breaking data changes; the identical data volume is
bidirectionally compatible with v0.9.16 (verified). In-app or host-side
update; automatic rollback on failed health checks.

## Security model

docs/SECURITY.md — secrets server-side only; helper is the only Docker-socket
component; reverse-proxy secret or trusted-LAN model; actions need a separate
`DOCKER: UPDATE_ANY` key and are audited; Agent API read-only by
construction.

## Known limitations

- Docker restart: not offered (the verified Unraid API exposes no restart
  mutation).
- iOS PWA: server-side identity complete; real-device QA is operator
  dependent (checklist in docs/PWA.md).
- Agent API is disabled until an operator configures a token.

## Verification

- Image: `ghcr.io/cyxno/unraid-dashboard:1.0.0-rc1`
- Digest: recorded at release time (repo ↔ registry match required by the
  deploy pipeline — "Registry verified")
- Rollback: previous validated release via Settings → Updates, or
  `scripts/update-dashboard.sh` with the previous tag.
