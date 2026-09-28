# Security

This document describes the security model, boundaries, and audits behind
the Unraid Dashboard. It is written for the operator of this deployment;
nothing here assumes other trust relationships.

## Threat model

Self-hosted dashboard on an Unraid home server. Trusted zone: the LAN
(192.168.1.0/24), Tailscale peers, and the Unraid host itself. Untrusted:
everything else (WAN, other VLANs, the public internet). Two credentials
exist server-side (a VIEWER read key and a narrowly-scoped GUEST action
key); neither ever reaches the browser.

## Security boundaries

1. **Browser ↔ dashboard (BFF)**: the browser can only call this app's
   own routes. It can never run arbitrary PromQL, never sees API keys,
   and never talks to the Unraid API or Prometheus directly.
2. **Dashboard ↔ Unraid API**: read-only VIEWER key for all state;
   lifecycle mutations use a physically separate action key restricted to
   `DOCKER:UPDATE_ANY,VMS:UPDATE_ANY` (reads denied to that key).
3. **Dashboard ↔ host**: the container runs unprivileged (non-root),
   host-networked, with **no Docker socket, no privileged mode, and no
   host shell access**. Its only host filesystem access is the narrow
   `/app/data` bind mount.
4. **Helper ↔ Docker (v0.7+)**: the update helper is the ONLY component
   with Docker access (see Update helper below).

## Authentication

`AUTH_MODE` drives identity handling:

- `disabled`: trusted-LAN behavior — every request is anonymous-local.
- `proxy` (production setting since v0.7): the trust boundary is a
  **proxy-injected shared secret** (`AUTH_PROXY_SECRET` arriving as
  `X-Dashboard-Auth-Token` from NPM alongside the Authelia identity
  header). The API layer compares it in constant time and the page
  middleware enforces the same rule; **fail-closed** when unset. Forged
  `X-Forwarded-For` / identity headers from the LAN are worthless without
  the secret — the header-spoofing caveat of plain proxy auth is closed.
  NPM additionally overwrites (never appends) the identity headers.
- Recovery: SSH to the host and recreate the container without
  `AUTH_MODE` (see /boot/config/plugins/dockerMan/templates-user/
  my-unraid-dashboard.xml for the current env); direct-LAN HTTP remains
  reachable at the firewall level for that path.
- **Kiosk path exception (v0.7.2):** `kiosk-dashboard.familievalk.com`
  skips Authelia forward-auth and injects a fixed `kiosk` identity. The
  trust comes from the network allow-list at the proxy (LAN + named
  Tailscale peers, deny all; CF-proxied traffic refused) plus the shared
  secret — anyone on those networks acts as the auditable `kiosk`
  identity. This is a deliberate, documented trade-off for unattended
  wallboards; it grants no broader rights than a trusted-LAN user and
  every action is audited as `kiosk`.

The dashboard never performs password auth and holds no user store.

## CSRF and write protection

All write endpoints (lifecycle actions, shared-dashboard mutations,
update/rollback/recovery operations): POST-only, same-origin enforcement
(Origin vs Host, `PUBLIC_BASE_URL` allow-list behind proxies),
`application/json` content-type required, per-actor rate limits,
cooldowns and mutual exclusion for lifecycle actions, and an append-only
JSONL audit trail that never contains credential material.

## Shared dashboards storage

- One JSON file per dashboard under `/app/data/dashboards`, filenames
  built only from server-generated ids validated against
  `^[a-z0-9]{12}$` **before** path composition — no traversal or
  unsafe-name vector. Defense-in-depth resolves and re-checks the path.
- Strict storage schema (unknown fields rejected); inputs are stripped to
  the schema (import round-trips tolerate evolution). Limits: 50
  dashboards, 64 KiB each, allowlisted widget ids, bounded strings.
- Ownership: proxy identity under `AUTH_MODE=proxy`; under trusted-LAN
  mode shared dashboards are editable by anyone on the trusted network —
  a deliberate, documented distinction (no accounts are invented).
- The schema cannot represent secrets; exports are layout/preference data
  only.

## Service worker

Static-only caching by design (`public/sw.js`, asserted by tests):

- `/api/*` responses are never cached, never served offline, never
  synthesized — an offline API request fails visibly and the UI labels
  state as stale/offline.
- Non-GET requests are never intercepted, stored, or replayed.
- Cross-origin requests are ignored; runtime cache is bounded.
- No secrets or auth-derived content enter any cache: only the shell
  document, manifest, icons and immutable `/_next/static` chunks.
- A new worker waits until the user confirms the refresh (no forced
  reload mid-action; no stale-JS-against-new-API window beyond the
  explicit banner).

## Update management

- The dashboard container is socket-free and cannot self-update or run
  host commands.
- GHCR login (`scripts/login-ghcr.sh`) reads a PAT interactively with
  minimum scope `read:packages`; the token is never committed, printed,
  stored in DockerMan templates, or exposed via the UI/API. Server-side
  update *checks* use `GHCR_TOKEN` which never leaves the process.
  v0.7.13: the credential store is persisted to the flash drive (0600)
  with a `/boot/config/go` boot-restore block, and bind-mounted read-only
  into the helper — one login covers host + helper pulls across reboots.
- **Update helper (shipped v0.7):** a dedicated single-purpose container
  — the only component with Docker access. Hard guarantees:
  * binds 127.0.0.1 only (verified by the deploy script against the host IP)
  * bearer-token auth with a constant-time compare (32+ char secret)
  * self-update requests can choose ONLY a semver tag
    (`^v?\d+\.\d+\.\d+$`); container updates choose ONLY a container
    name; the image repo and container name are deployment-time env
    constants
  * no shell — every docker call is spawn(argv array); request fields
    outside `tag`/`name`/`project`/`confirm` are ignored by construction
  * single-flight lock (409 on concurrent updates); dashboard-side
    refuses non-newer versions and duplicates
  * phase machine with wall-clock timeouts that always settles; failures
    before the first mutation leave the running container untouched
    (`mutated` flag); post-replace failures restore the previous image
    with preserved config (env via 0600 temp file, provenance keys
    excluded)
  * verification of /api/health, /api/version (tag match), /api/overview
  * all attempted updates audited on the dashboard side (actor, versions,
    result, duration); the helper's /status exposes phases and results,
    never tokens
- **Compose service updates (v0.7.11):** paths come only from the
  container's own compose labels, validated against deploy-time
  read-only root mounts (`COMPOSE_ALLOWED_ROOTS`); every invocation is a
  scoped argv array (`compose pull`/`up -d --no-deps <service>`).
- **Project updates (v0.7.13):** the request names ONLY the project.
  Members, order and paths derive server-side from live labels plus
  `docker compose config`. Refused entirely for pipeline-owned projects,
  any HIGH-risk member (databases/auth/proxy/DNS), AIO/externally
  managed or non-recreatable members, and ambiguous dependency graphs
  (cycles, configured services without containers). Services update one
  at a time (dependencies first), health-validated, stopping on the
  first failure with the failed service rolled back. Project-level
  automation can therefore never bypass per-service risk policy — the
  helper re-derives every refusal even if the dashboard were bypassed.
- **Rollback readiness (v0.7.13):** mutation requires a resolvable
  running image; a stored pre-update snapshot makes rollback *proven*
  (surfaces as rollback level `ready` vs `unproven`). Snapshots contain
  env values and are stored 0600 in the helper state dir; no endpoint
  ever returns their contents — only presence metadata.
- **Recovery actions (v0.7.13):** the Operations page exposes only:
  create/validate resilience backup, restore dry-run, dependency-check
  retry, and clearing a stale PRE-mutation operation (the helper refuses
  post-mutation clears and verifies the target container is running).
  No generic shell, no arbitrary restore, no arbitrary image rollback.

## Pipeline-owned projects (v0.7.13)

Compose projects listed in `PIPELINE_OWNED_PROJECTS` (default
`tornscope`) or labeled `com.cyxno.management=pipeline` are classified
`pipeline_owned`: the dashboard detects their update state for display
but refuses every mutation, at both the dashboard gate and the helper.
Optional declarative metadata (`com.cyxno.pipeline.repo/deployer/sha/
ref`) is display-only. `com.cyxno.update.policy`/`risk` labels are
declarative metadata that can only TIGHTEN policy (toward manual /
higher risk) — labels never loosen server-side classification.

## Port isolation (live on this host)

Direct access to the dashboard port (8090) is restricted by iptables
(persisted in `/boot/config/go`) to loopback, the LAN, Docker bridges
(the NPM proxy hop), Tailscale and Unraid WireGuard ranges. Everything
else is dropped. The reverse-proxy path adds Authelia two-factor
authentication and strips/overwrites client identity headers. Recovery:
SSH to the host (unaffected), then remove the rules or use the direct LAN
path; the disable command is documented in `/boot/config/go`.

## Data handling

- `/app/data` holds the audit log, update history and shared dashboards
  only — no secrets are stored by the app (API keys live in container
  env only).
- Diagnostics and the Operations page expose
  latency/reachability/counters/bytes — never secret material, tokens,
  or env values.
- Logs scrub credential-looking assignments before audit entries are
  written.

## Known limitations

- With `AUTH_MODE=disabled` (not current production), identity is not
  asserted on the direct-LAN path by design; the Authelia-protected proxy
  path is the identity-bearing path.
- The proxy path's allow-list blocks cloud IPs; remote access requires
  Tailscale (deliberate).
- Prometheus queries are built server-side from validated windows only;
  the browser cannot inject PromQL. Prometheus itself is unauthenticated
  on the LAN — out of scope for this app.
- Broad auto-update stays disabled in v0.7.13: the eligibility model is
  computed and displayed, but nothing schedules or executes automatic
  updates, and a future pilot mode would be allowlist-gated to LOW-risk
  containers with a proven rollback record.
