# Changelog

All notable Beacon releases, newest first. Groups are optional per release;
only non-empty groups are shown. No dates — versions are ordered by semver.

## v1.1.0

### Added

- In-app Changelog page (`/changelog`) with release history, current-version highlight and deep links

## v1.0.1

### Fixed

- Service worker version now follows the deployed release version, preventing installed PWA clients from retaining an older shell

## v1.0.0

### Added

- Operational Unraid dashboard: overview, Docker operations, storage, system, network, VMs, notifications, logs, audit and NOC wallboard
- Docker lifecycle actions (start/stop) with confirmation, live verification and audit trail
- Storage monitoring with per-disk status and temperatures
- Thermal intelligence: 24h analysis, 7-day context, hot-episode correlation and idle-hot detection
- Capability-aware Automation with opt-in pilot auto-updates and proven rollback
- Strict verified updates: registry digest match, automatic rollback, provenance badge
- Installable PWA with offline shell and mobile-first navigation
- Read-only Agent API v1 for machine integrations

### Security

- Credentials stay server-side; the app has no Docker socket (isolated update helper)
- Every mutation is confirmed, cooldown/rate-limited and audit-logged
- Reverse-proxy auth with shared secret or trusted-LAN model

## v1.0.0-rc1

### Developer

- Release candidate: added semver prerelease support to the strict update train
- Validated persistence migration and rollback against production data
- Completed release-hardening, security and recovery audits

## v0.9.16

### Fixed

- Finalized one-click Docker section navigation
- Improved scroll settling on dynamically expanding sections

## v0.9.15

### Fixed

- Anchor sections now follow lazily mounted content as it grows

## v0.9.14

### Fixed

- Page footer clears the mobile bottom navigation like main content

## v0.9.13

### Improved

- Settings columns balanced using measured production content heights

## v0.9.12

### Fixed

- Overview dead bands: independent column stacks replace row-coupled grids
- Settings columns rebalanced so both stay populated
- Docker anchors expand, mount, scroll and highlight in one action

### Added

- Public documentation overhaul: install, configuration, updating, security, architecture, troubleshooting, roadmap
- Demo mode documentation and curated screenshot workflow
- Layout gates for column balance and section spacing

## v0.9.11

### Added

- Thermal intelligence: 7-day context, hot-episode correlation with top consumers, idle-hot detection
- Capability-aware Automation with per-workflow eligibility and specific blockers
- Read-only thermal context in the Agent API

### Improved

- Health reasons ranked critical-first with a tap-to-explain popover

## v0.9.10

### Added

- Unified verified action controller shared by the Docker list and container detail
- 7-day thermal context and normalized action capability model

### Fixed

- Contradictory memory figures (percent now derived from used/total)

## v0.9.9

### Added

- Docker action readiness with bounded transition verification
- Cached update awareness: Updates badge and summary without registry sweeps

### Improved

- Health explanation surfaced directly in the header

## v0.9.8

### Fixed

- Mobile footer clearance under the bottom navigation
- Bottom navigation made opaque so content no longer shows through

### Improved

- PWA icon cache-busting and iOS identity documentation

## v0.9.7

### Added

- Layout primitives and spacing tokens shared across pages

### Fixed

- Overview and Settings dead space from grid stretching
- Contradictory RAM usage figures
- PWA service-worker and icon staleness

## v0.9.6

### Fixed

- Mobile anchor and section-navigation interactions
- Visual defects caught by the new layout gates

## v0.9.5

### Added

- Operations-first Docker layout groundwork

### Fixed

- Mobile navigation and sheet fixes

## v0.9.4

### Added

- Read-only Agent API v1 under /api/agent/v1

## v0.9.3

### Added

- Safe notification bulk operations
- Automation evaluation streaming via SSE
- NOC per-widget customization

## v0.9.2

### Fixed

- Release and version correctness
- Faster automation state updates
- Docker list prioritization
- Notification and log improvements

## v0.9.1

### Added

- Storage page redesign
- NOC wallboard redesign
- Visual regression tooling

## v0.9.0

### Added

- Beacon branding and identity
- 8 themes with accent system
- PWA foundation and installable shell
