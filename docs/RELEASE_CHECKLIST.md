# v1.0 release-blocker checklist

A release is blocked by ANY of:

- [ ] data-loss risk (persistence write that corrupts or loses prior state)
- [ ] broken persistence migration (old data unreadable after upgrade)
- [ ] broken rollback (previous version cannot boot/read state)
- [ ] auth/security regression (any matrix check off expected code)
- [ ] action safety failure (unconfirmed mutation, missing audit, wrong target)
- [ ] update/provenance failure (digest mismatch shipped, non-registry image)
- [ ] core page unusable (Overview/Docker/Storage/System render broken)
- [ ] persistent resource leak (monotonic RSS/FD growth at steady state)
- [ ] Agent API contract break (removed/repurposed endpoint or field)
- [ ] fatal mobile shell regression (content under nav, unusable sheets)
- [ ] unrecoverable corrupted state (no resilience-backup path)

NOT blockers (documented limitations, tracked in docs/ROADMAP.md):

- no native Docker restart (Unraid API limitation)
- iOS real-device QA pending operator hardware
- future widgets/integrations
- cosmetic polish without usability impact


---

# v1.3.16 release-gate checklist (runtime + image + contract)

This section exists because of the v1.3.13 incident: the helper shipped with
a missing module import. Pure unit tests were green, the image built, CI
passed — and the runtime wiring failure only surfaced after deployment. The
safety net (last-known-good inventory + degraded health) held, but the
release should never have reached production. The gates below make that
class of failure unshippable.

## Gates, in order

1. **Source gates (CI, every push)** — lint, typecheck, full suite. The suite
   includes the helper **runtime smoke** (tests/v1316-helper-runtime.test.mjs):
   the real entrypoint boots as a subprocess against a mocked Docker CLI and
   /health + /inventory are exercised end-to-end. A missing import is hard red.
2. **Version contract** (tests/v1316-release-contract.test.ts) — package.json
   version = helper HELPER_VERSION = changelog latest; golden inventory
   fixture flows through the runtime Zod schema and the real dashboard model;
   stopped ≠ problem, update-count consistency, cAdvisor query semantics.
3. **Image build + boot smokes (docker-publish.yml: build-and-smoke)** — both
   images build (not pushed) and boot for real:
   - dashboard: /api/health, /api/version == tag, gitSha present, PWA
     manifest + sw + root 200, SSE hello;
   - helper: boots with a mocked Docker CLI; a FRESH /inventory must succeed
     with 0 failures, non-degraded diagnostics and inventoryStatus healthy
     (new container = empty cache, so stale-cache green is impossible);
     helper/inventory.js must exist inside the image.
4. **Publish (needs build-and-smoke)** — validated candidates are pushed and
   then re-verified against the published tags (pull + same smokes):
   artifact == validated artifact.
5. **Deploy prechecks (scripts/deploy-helper.sh)** — version-label precheck
   (label must match requested tag) and an isolated candidate smoke on port
   8791 with the real Docker socket: fresh inventory healthy or production is
   never touched. Emergency escape: SMOKE=0 (conscious choice only).
6. **Post-deploy gates** — helper deploy completes only after a fresh
   /inventory refresh succeeds and /health reports inventoryStatus healthy
   (partial allowed with the degraded warning). Dashboard deploy keeps the
   existing health + live-API verification with automatic rollback.

## Tag policy

Tags are immutable. If publish fails after tagging, the release stays
incomplete and the next patch version is cut — never a tag rewrite, never a
force-push. The build-and-smoke job in the tag run gates tag → registry.

## Required CI checks (repo settings recommendation)

- test (ci.yml)
- build-and-smoke (docker-publish.yml)

Setting branch protection is a GitHub settings decision, not automated here.
