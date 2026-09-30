# Changelog

All notable changes to Beacon. Versions follow semver-ish 0.9.x increments;
each entry summarizes user-visible changes.

## v0.9.12 — layout flow + docs

- Overview rebuilt on independent column stacks: no more blank bands under
  shorter cards; content packs continuously like an operations dashboard.
- Settings rebalanced so both columns stay meaningfully populated; card order
  leads with everyday settings.
- Docker section anchors now expand, mount, scroll to and highlight the target
  section in one click (secondary sections stay lazy — page entry still never
  triggers a registry sweep).
- Column-imbalance layout gates added to the visual harness; demo-mode payload
  hardening (no crash on missing update summary).
- Public-facing documentation overhaul: README, install/configuration/updating/
  security/architecture/troubleshooting/roadmap docs, changelog, contributing
  guide, issue templates, curated demo screenshots.

## v0.9.11 — thermal intelligence + capability-aware automation

- Idle-hot episode classification ("elevated temperature with low observed
  load"), window-median power baseline.
- 7-day thermal context: previous-week average + week-over-week delta, data
  coverage ratio, recent sustained-episode list.
- Automation: normalized per-workflow eligibility (update-helper,
  lifecycle-start/stop, restart) with specific blockers; computed live so a
  removed action key flips surfaces everywhere with no stale Ready.
- Agent API: read-only thermal context block.

## v0.9.10 — unified actions + capability model

- One shared verified-action controller for the Docker list and the container
  detail page (confirm → request → SSE/poll → timeout → feedback).
- Normalized action capability model served by /api/actions/status and reused
  everywhere; restart/pause permanently false.
- PWA secret hygiene: env variable names removed from client bundles.

## v0.9.9 — live actions readiness + update awareness

- Action state machine with bounded transition verification (SSE
  state-transition event + polling fallback); visible timeout states.
- Cached update summary endpoint (~3 ms): Docker page shows an Updates badge
  and collapsed summary without triggering the registry sweep.
- Health reasons ranked critical-first; header health badge opens an
  explanation popover. Unraid API verified live: start/stop only, no restart.

## v0.9.8 / v0.9.7 — layout system + memory semantics + PWA identity

- Spacing tokens, shared layout primitives (PageStack, AdaptiveColumns…),
  items-start columns, Overview/Settings dead-space fixes.
- One authoritative --mobile-bottom-clearance; opaque bottom nav.
- Memory semantics fixed (used = total − available; percent derived) with an
  enforced invariant — ended contradictory "78% / 60 of 62 GiB" displays.
- PWA icon cache-busting, root apple-touch-icon, iOS documentation.

## v0.9.5 / v0.9.6 — mobile shell + operations-first Docker

- Mobile bottom nav + More sheet, safe-area system, scroll locks, drawer
  semantics; Views control only where it applies.
- Docker page rebuilt operations-first: containers first, Updates/Projects/
  History lazy, anchor row, operational sort, mobile cards.
- Visual harness with overflow + overlay fit + semantic layout gates.

## v0.9.4 — Agent API

- Read-only machine API under /api/agent/v1 (bearer auth, rate limits, issue
  engine, capability facts). No write endpoints, enforced by tests.

## v0.9.3 — interaction safety + automation SSE

- Confirmation/cooldown/rate-limit surfaces, automation evaluations via SSE,
  NOC per-widget customization.

## v0.9.2 — correctness

- Health/banner fixes, update-awareness chips, stale-shell version handling.

## v0.9.1 — visual regression harness

- Screenshot + overflow gates across pages/themes/breakpoints.

## v0.9.0 — Beacon identity

- Product naming, design tokens, 8 themes + accents, appearance system, PWA
  foundation.
