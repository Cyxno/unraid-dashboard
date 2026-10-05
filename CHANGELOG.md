# Changelog

All notable Beacon releases, newest first. Groups are optional per release;
only non-empty groups are shown. No dates — versions are ordered by semver.

## v1.3.18

### Fixed

- **OCI provenance labels are now exact and whitespace-free on both images**: the helper image bakes its version/revision/channel labels in-image (matching the dashboard), and every image smoke asserts the RAW label values with exact equality — leading/trailing whitespace in a produced artifact is a release blocker. Deploy prechecks keep their defensive trimming for third-party artifacts
- **Release semver tags on GHCR are immutable again**: main/latest builds no longer push the package version tag (they publish `:latest` and `:sha-` only), so a main push can no longer overwrite a released version with a main-channel build

## v1.3.17

### Improved

- **Version and build provenance are now consistent across dashboard, helper, GHCR and Settings**: the product version is always the package semver; release builds take it from the tag and main/latest builds from package.json, with the build channel and revision exposed separately (`/api/version`, OCI labels) — a branch name is never a version
- **Release metadata is validated before publication**: image boot smokes now include the version/channel contract and the published-artifact re-verification annotates every failure cause
- Settings-facing version reporting includes the build channel alongside version, SHA and build time

### Removed

- Removed temporary QA scratch scripts and screenshots (tmp-qa) and tightened the lint scope (first-party sources, tests and scripts only; generated/temp/fixture paths are documented exclusions)
- Zero-warning lint target reached for the full lint scope; unused imports now get a safe autofix via eslint-plugin-unused-imports

## v1.3.16

### Improved

- **Release pipeline now validates helper/dashboard runtime integration before images are published**: both images boot in CI — the helper against a mocked Docker CLI requiring a fresh, healthy inventory, the dashboard with version/PWA/SSE checks — and publish only runs after those smokes pass, with a re-verification of the published tags
- **Production updates now require healthy fresh inventory state**: the helper deploy precheck boots the candidate isolated on an alternate port (fresh inventory healthy or production is never touched), verifies the image version label against the requested tag, and the post-deploy gate requires a successful fresh refresh — process health alone is no longer deployment success

### Fixed

- **Release gates prevent missing runtime modules and version-contract mismatches from reaching production**: the suite boots the real helper entrypoint end-to-end (the v1.3.13 missing-import class is now hard red before release) and the dashboard validates helper responses at runtime with a Zod contract (drift degrades instead of poisoning the update model)
- **Inventory no longer freezes after the first refresh**: the helper's single-flight promise was never cleared once settled, so /inventory replayed the boot-time result until an update invalidated the cache — the next cache miss now performs a real fresh refresh; an all-chunks-failed refresh is a hard failure that serves last-known-good instead of an empty-facts inventory

## v1.3.15

### Improved

- Inventory facts now carry the canonical full 64-char container id (`idFull`) alongside the short display id, completing the identity contract (short id stays in `id`/`idShort` for compatibility)

## v1.3.14

### Fixed

- Helper release fix: the v1.3.13 inventory module import was missing in the shipped entrypoint, so every inventory refresh failed (helper correctly served last-known-good + degraded health instead of an empty wipe — the new safety net working as designed). Import restored; both components now ship as 1.3.14

## v1.3.13

### Fixed

- **Hardened Docker inventory parsing for large and multi-container inspect responses**: inspect output is parsed line-by-line (NDJSON), runs in deterministic 25-container chunks with one bounded retry, and the CLI output capture cap was raised so no tail of the container list can silently disappear
- **Container metadata no longer silently disappears when individual inspect records fail**: a malformed line or failing chunk now degrades only its own containers, is counted in diagnostics, and never wipes the batch or poisons the cache — failed refreshes keep serving last-known-good data marked degraded
- **Full Docker IDs are now matched reliably against short Docker IDs**: short 12-char ps ids and full 64-char inspect ids are indexed together, with malformed-id rejection and duplicate detection

### Improved

- Inventory diagnostics now detect partial/degraded refreshes instead of treating missing metadata as valid: the inventory response carries an additive diagnostics block (coverage, failures, chunks, duration, structural-degradation flag) and the health endpoint reports inventory pipeline status — an all-local-build host can never false-positive
- Large Docker installations are handled in bounded batches (tested with 250/500-container fixtures; single-flight unchanged; no N+1 regression)

## v1.3.12

### Fixed

- **Updates counter and update summary can no longer diverge.** The light summary counted a pipeline-owned container's registry update while the full model correctly withheld it (the pipeline is the updater) — one code path now derives both, so badge, counter, filter and summary are provably the same set

## v1.3.11

### Fixed

- **Inventory no longer loses the tail of the container list.** The helper capped captured Docker CLI output at 400 KB while a full batch inspect is ~0.5–1 MB, so the last ~14 containers silently lost their inspect facts and kept falling back to empty classification input. The capture cap is now 8 MB

## v1.3.10

### Fixed

- **Helper inventory was still degraded: every container lost its facts.** The batch `docker inspect` joins on short 12-character ids from `docker ps`, while inspect returns full 64-character ids — every lookup missed, so all containers fell back to empty facts (no labels, no digests) and the update model had nothing to work with. Both id forms are indexed now; production inventory returns real facts again (54/62 containers with registry digests, 8 proven local/pipeline builds)

## v1.3.9

### Fixed

- **Docker update badges, counters, filters and the update summary now use one consistent update state.** The row badges came from Unraid's inventory flag while the updates panel used Beacon's own registry checks, so the page could show "Updates 7" next to "0 known updates · stale". Every consumer now derives from a single canonical verdict (`canonicalUpdateState`), served from the same cache and invalidated together after an update completes
- **Registry-managed images are no longer incorrectly classified as local builds.** A broken batch-inspect parse in the helper degraded every container's facts (no labels, no digests), which the "no registry digest ⇒ local build" shortcut turned into "62 local builds" — including obvious registry images like netdata/netdata. Line-delimited inspect output is parsed correctly now, and a missing local digest is no longer evidence: only the registry's own 404 proves a locally built image (8 of 62 containers on production; the other 54 are registry-managed)
- **Stale update data no longer claims that all containers are up to date.** The updates panel shows "no known updates · stale data" / "last known" instead of a strong freshness claim over old cache, and a container whose local digest is unknown reports UNKNOWN rather than a fabricated up-to-date/update verdict

### Improved

- Clearer update-state and toolbar presentation: the "Update" filter is labelled "update available", the high-risk stat is labelled as the policy count it is, and the sort/density controls are visually grouped as view controls

## v1.3.8

### Fixed

- **Stopped Docker containers are no longer treated as problems.** The Docker page's Problems filter and problem counter used "not running" as failure evidence, so deliberately stopped containers (maintenance tools, one-shot utilities) were counted as problems. A new canonical classifier (`classifyContainerHealth`) now drives the filter and counters: only unhealthy, restarting/crash-loop and concrete error states are problems — stopped, exited and paused containers stay visible with their neutral Stopped/Paused state
- Intentionally inactive containers remain visible under the Stopped filter and no longer inflate the Problems count or the dashboard health level
- Autostart-enabled stopped containers are not flagged either: autostart does not imply a 24/7 expectation, and the container inventory carries no exit codes, so stale non-zero exit codes cannot surface as failure evidence

### Improved

- Dashboard and helper release versions are aligned again: both ship as v1.3.8 (the helper had been reporting v1.3.5/0.9.5 while the dashboard moved ahead)

## v1.3.7

### Fixed

- **Container CPU was a factor-16 too low** (v1.3.6 regression): the cAdvisor query divided by `machine_cpu_cores`, but docker stats CPUPerc — Beacon's historical semantic — is a **per-core percentage**: 1 fully-used core = 100%, 2 cores = 200%. Proven with a controlled `--cpus=0.5/1/2` quota test (docker reported 50.7%/101.7%/202.3%) and a 60-minute parallel comparison (median ratio OLD/corrected = 1.29 vs OLD/host-normalized = 0.08 ≈ 1/16). All container-CPU consumers (overview, detail, history, top consumers, thermal attribution, thresholds) now use `rate(container_cpu_usage_seconds_total) × 100` — no division. The 80% high-CPU threshold again means "≈0.8 core", values above 100% remain valid and unclamped
- Historical data needed no migration: CPU percentages are computed at query time from the raw cAdvisor counter, so the correction applies retroactively to all graphs

## v1.3.6

### Improved

- **Container CPU/memory metrics now come from cAdvisor instead of the custom docker_stats textfile gauges.** Containers are joined by Docker container id (cAdvisor cgroup `id` label vs the helper inventory), not by name, so a recreated container (same name, new id) no longer blends with its predecessor's history. Destroyed-container leftovers are excluded via a `container_last_seen` freshness guard, so ghost entries can no longer appear in top consumers
- Container CPU percent is now a 2-minute rate average expressed as % of total host capacity (`rate(container_cpu_usage_seconds_total)/machine_cpu_cores`), matching the previous docker-stats semantics minus the ~1-second snapshot spikiness — values move smoother and spikes are less extreme
- Container history (CPU + memory) works retroactively: cAdvisor counters have been scraped all along, so graphs show continuous data across the migration
- Thermal episode per-container attribution uses the same cAdvisor CPU series (same % semantics, no unit shift)

### Fixed

- Unlimited containers no longer show a fake memory cap: cgroup-v2 reports limit 0 where docker-stats reported the host's total RAM — the dashboard now treats that as "no limit" and shows memory as % of host RAM, exactly like docker stats did

### Security

- No component change; the removal path for the 15s `docker stats --no-stream` collector (a container with the Docker socket) is now documented in `docs/DOCKER_STATS_RETIREMENT.md` — disable it only after this release is verified in production

## v1.3.0

### Added

- **First-time setup wizard**: a fresh install opens a guided setup instead of requiring environment variables — connect to the Unraid API, choose a security mode, done. Requires a one-time, host-generated setup token (0600 file under /app/data) so nobody on the network can claim setup without host access
- **Three authentication modes**: Trusted Network (default, no login — backward compatible with all existing installs), Local Login (built-in username/password with scrypt hashing, HttpOnly session cookies, rate-limited login, session-epoch logout), and Reverse Proxy (the existing trusted-proxy model)
- **Settings → Security**: shows the current auth mode, HTTPS state, action capability, helper status and push configuration in one card
- **ENV > UI > default precedence**: settings from environment variables show "Managed by environment" and cannot be silently overridden by the UI
- **Setup token**: 32-byte random, host-generated, single-claim (atomic; second claim rejected 409), deleted after use
- Local login over plain HTTP warns "insecure connection" in the UI (the login still works; the warning is informational)

### Security

- Local auth passwords are hashed with scrypt (N=2^15) and stored in the 0600 config file; never plaintext, never returned by the API
- Session cookies are HttpOnly, SameSite=Lax, Secure when served over HTTPS; session tokens are HMAC-SHA256 signed with a per-install secret and bound to a session epoch (credential change invalidates all sessions)
- Login is rate-limited per source IP with generic error messages (no username enumeration)
- Setup claim is race-safe (in-process lock + atomic file write); the setup token is deleted after successful claim
- No first-visitor-wins: setup requires host filesystem access to read the token

## v1.3.1

### Fixed

- Compose: UNRAID_API_KEY no longer fails hard on fresh install — the setup wizard collects it from the browser
- Unraid template: UNRAID_URL and UNRAID_API_KEY are now optional (setup wizard collects them)
- Notification preference saves are rate-limited (was missing)
- env AUTH_MODE schema: added "local" to the enum (was missing from the deployment override)

### Added

- Settings → Security status card: auth mode, Unraid connection, action key, helper status, push configuration
- scripts/reset-local-auth.sh: host-side recovery for forgotten local password (reverts to trusted mode, invalidates all sessions)

## v1.3.4

### Added

- Helper inventory single-flight coalescing: concurrent /inventory requests share one in-flight Docker CLI refresh instead of each spawning N+1 processes. Reduces helper CPU bursts from N+1 spawns per request to 1 shared refresh per 10-second TTL window

### Improved

- Helper image includes the inventory read cache and coalescing optimizations from the performance audit

## v1.3.3

### Fixed

- Local login was broken in the Alpine standalone container: scrypt with N=2^15 exceeded the OpenSSL default memory limit, causing hashPassword to throw on every attempt. Reduced to N=2^14 (still OWASP-acceptable) with explicit 64 MB maxmem
- Setup claim did not generate a session secret when local auth was selected — login always returned "Session secret not configured" after setup completed with local auth

## v1.3.5

### Fixed

- Inventory cache is now invalidated after container mutations (recreate, update, compose up) — the previous 10s TTL allowed stale data for up to 10 seconds after a container change

## v1.3.2

### Added

- Settings → Configuration: every runtime setting with ENV/UI/Default source badge, effective value (secrets masked), restart-required markers and Test connection buttons (Unraid, Prometheus)
- Local auth: Log out button and "Sign out all devices" (session-epoch bump) in the Security status card
- Credential change endpoint (current-password verified, session-epoch bumped)

### Fixed

- Notification subscription DELETE used the POST-only guardWrite (v1.2.0 regression) — devices could never unsubscribe

## v1.2.3

### Fixed

- **Device unsubscribe was broken**: the notification subscription DELETE handler used the POST-only write guard, so every unsubscribe attempt was rejected with 405 — devices could never unbind through the API. Now uses the DELETE guard with the identical CSRF posture
- Notification preference saves are now rate-limited like every other notification mutation

### Security

- Added Strict-Transport-Security (ignored over the HTTP LAN fallback, enforced on the Tailscale HTTPS origin); CSP, frame-ancestors 'none', X-Frame-Options DENY, nosniff, Referrer-Policy and Permissions-Policy were already in place and verified
- Security-posture regression suite locking route guards, DELETE/POST guard separation, HSTS/frame headers, absence of shell composition and log-read allowlisting

## v1.2.2

### Fixed

- Notification permission state misreported "blocked" in environments where the browser reports `denied` without a per-site user choice — most notably **plain-HTTP (LAN) access**, where Chromium and Firefox always report denied. The section now classifies the insecure context first and shows "requires HTTPS" with the correct explanation instead of impossible "re-enable in site settings" advice. `Notification.permission` remains the live, authoritative browser state; "default" is never presented as blocked

### Improved

- Development builds log a read-only notification capability payload (permission, secure context, service worker/push support, install state, subscription presence, derived state) to make future state questions diagnosable

## v1.2.1

### Fixed

- Notification evaluation now starts with the server process (Next.js instrumentation) instead of requiring someone to visit a notification route first — without this, push delivery and history silently never ran on a fresh install
- First-run/upgrade anti-spam: on a fresh notification state (new install, or upgrade from v1.1.x) existing conditions are baselined silently — only future transitions notify, so activating notifications never floods devices with pre-existing problems
- iPhone Safari without a Home Screen install now shows an honest "home-screen install required" state with instructions instead of a broken Enable button

### Improved

- VAPID variables are now present in every official install route: docker-compose (optional, commented) and the Unraid template (private key masked, no defaults)
- Corrupt notification state recovers to a clean baseline with a log warning instead of crashing; restart dedupe proven (recreating the process never re-pushes known conditions)
- Subscription route is rate-limited with a 16 KB payload cap; notification history shows friendly delivery labels and categories; preferences scope documented in the UI

## v1.2.0

### Added

- **Notification system with Web Push (opt-in)**: critical conditions, recoveries and updates can notify you even when no Beacon tab is open. Stable-fingerprint events (a two-hour unhealthy container notifies once, recovery notifies optionally, recurrence notifies again), severity and category filters, per-device subscriptions, an in-app notification history with delivery status, and a real "Send test notification". Standard Web Push with VAPID — no external service; fully functional without configuration (in-app delivery and history only)
- Service worker now handles `push` and `notificationclick` (opens/focuses Beacon on the event's deep link)

## v1.1.5

### Fixed

- Stopped autostart containers no longer trigger the global warning banner: `autostart=true + exited` is configuration + state, not an objectively detectable problem (users legitimately keep rarely used containers stopped). Real failure signals — unhealthy containers, array/disk/parity issues, alerts, memory/temperature pressure — keep their existing health impact

### Improved

- The Docker page surfaces the combination as neutral metadata: a muted "Autostart · stopped" badge on the container row (mobile card and desktop table), with no warning styling

## v1.1.4

### Fixed

- Overview hero strip showed "State unknown" for attention-level health situations (e.g. stopped autostart containers) instead of "Needs attention" — the verdict compared against a health-level value that does not exist; the warning banner above it was already correct

## v1.1.3

### Fixed

- Update detection now actually sees remote releases: GHCR paginates the tag list (100 per page, sha tags included) and the newest semver tag had fallen off the first page — the check compared against an old tag and reported "up to date" while newer releases were live
- Locally present images are no longer presented as the "latest release" when the registry check has no answer: local images are discovery-only, the status stays an explicit degraded/unknown state instead of a false "up to date"

### Improved

- "Check for updates" now forces a fresh remote lookup (bypassing the background cache) with visible states: spinner + "Checking…", disabled during the request, "Last checked" confirmation, inline error on failure, and an explicit source badge (GHCR vs local fallback)

## v1.1.2

### Fixed

- iPhone standalone PWA: the header now grows with the top safe-area inset instead of clipping its content under the status bar (notched and Dynamic Island devices); browser tabs keep the exact previous geometry
- Live servers no longer show "Demo" labels when a single section fails (a key role the API rejects, a failing query, a boot race): demo data is shown only while the Unraid API has never responded since process start — missing integrations surface as honest degraded states instead

### Improved

- Demo mode explains itself: a dismissible banner states the connection reason (rejected API key vs unreachable API) instead of a bare "Demo data" badge
- Update checks work without GHCR_TOKEN for the public package (anonymous registry check); Settings shows accurate registry state instead of "the package is private"

## v1.1.1

### Improved

- Public-release polish: README restructured as a project landing page with a curated, correctly-proportioned screenshot showcase and a quick start
- SECURITY.md rewritten for a public audience, with a vulnerability-reporting section and genericized trust model
- Curated screenshots re-captured from the synthetic demo dataset (viewport aspect ratios, desktop and mobile presented separately)
- Operator-specific files and references removed from the repository (recovery runbook, scratch scripts, stale example values)

### Fixed

- Auth-expired overlay no longer links to a hardcoded sign-in portal; re-authentication relies on your proxy's normal sign-in flow
- Three pre-existing eslint errors resolved (changelog deep-link effect annotation, unescaped apostrophe, test import style)

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
