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

All write endpoints (lifecycle actions, shared-dashboard mutations):
POST-only, same-origin enforcement (Origin vs Host, `PUBLIC_BASE_URL`
allow-list behind proxies), `application/json` content-type required,
per-actor rate limits, cooldowns and mutual exclusion for lifecycle
actions, and an append-only JSONL audit trail that never contains
credential material.

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

## Release train (v0.7.x)

Releases ship incrementally (0.7.1 … 0.7.5), each independently gated
(lint/typecheck/tests/build/browser validation), deployed through the
update pipeline, and tagged with the exact deployed commit. Rollback
targets are restricted to the validated list from the persisted update
history — never arbitrary tags. Invariants maintained across all
releases: no Docker socket in the main dashboard, helper stays
single-purpose, secret-boundary proxy auth, no secrets in audit or
shared dashboards, static-only service-worker caching.

## Update management

- The dashboard container is socket-free and cannot self-update or run
  host commands.
- Updates run host-side via `scripts/update-dashboard.sh`: same env/keys/
  network/volumes preserved, health-check on `/api/overview`, automatic
  rollback on any failure. Tag pinning: the script only pulls the image
  reference you pass it; nothing arbitrary is accepted from the UI (the
  UI exposes no update action at all in v0.6).
- GHCR login (`scripts/login-ghcr.sh`) reads a PAT interactively with
  minimum scope `read:packages`; the token is never committed, printed,
  stored in DockerMan templates, or exposed via the UI/API. Server-side
  update *checks* use `GHCR_TOKEN` which never leaves the process.
- **Update helper (shipped v0.7):** a dedicated single-purpose container
  — the only component with Docker access. Hard guarantees:
  * binds 127.0.0.1 only (verified by the deploy script against the host IP)
  * bearer-token auth with a constant-time compare (32+ char secret)
  * requests can choose ONLY a semver tag (`^v?\d+\.\d+\.\d+# Security

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

## Authentication

`AUTH_MODE` drives identity handling:

- `disabled` (current production setting): trusted-LAN behavior — every
  request is anonymous-local. Appropriate because direct access is
  LAN-only (see Port isolation) and the reverse proxy adds Authelia 2FA.
- `proxy`: requests must arrive via the trusted reverse proxy and present
  the `AUTH_HEADER` identity (injected by Authelia forward-auth, always
  overwriting client-supplied values). Direct requests are rejected.
  Caveat (standard for proxy auth): without network-level port isolation,
  LAN clients could spoof identity headers — that is exactly what the
  8090 isolation rules mitigate, and flipping `AUTH_MODE=proxy` remains a
  documented operational step.

The dashboard never performs password auth and holds no user store.

## CSRF and write protection

All write endpoints (lifecycle actions, shared-dashboard mutations):
POST-only, same-origin enforcement (Origin vs Host, `PUBLIC_BASE_URL`
allow-list behind proxies), `application/json` content-type required,
per-actor rate limits, cooldowns and mutual exclusion for lifecycle
actions, and an append-only JSONL audit trail that never contains
credential material.

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
- Updates run host-side via `scripts/update-dashboard.sh`: same env/keys/
  network/volumes preserved, health-check on `/api/overview`, automatic
  rollback on any failure. Tag pinning: the script only pulls the image
  reference you pass it; nothing arbitrary is accepted from the UI (the
  UI exposes no update action at all in v0.6).
- GHCR login (`scripts/login-ghcr.sh`) reads a PAT interactively with
  minimum scope `read:packages`; the token is never committed, printed,
  stored in DockerMan templates, or exposed via the UI/API. Server-side
  update *checks* use `GHCR_TOKEN` which never leaves the process.
); the
    image repo and container name are deployment-time env constants
  * no shell — every docker call is spawn(argv array); request fields other
    than `tag` are ignored by construction
  * single-flight lock (409 on concurrent updates); dashboard-side refuses
    non-newer versions and duplicates
  * phase machine with wall-clock timeouts that always settles; failures
    before the first mutation leave the running container untouched
    (`mutated` flag); post-replace failures restore the previous image
    with preserved config (env via 0600 temp file, provenance keys excluded)
  * verification of /api/health, /api/version (tag match), /api/overview
  * all attempted updates audited on the dashboard side (actor, versions,
    result, duration); the helper's /status exposes phases and results,
    never tokens

## Port isolation (live on this host)

Direct access to the dashboard port (8090) is restricted by iptables
(persisted in `/boot/config/go`) to loopback, the LAN, Docker bridges
(the NPM proxy hop), Tailscale and Unraid WireGuard ranges. Everything
else is dropped. The reverse-proxy path adds Authelia two-factor
authentication and strips/overwrites client identity headers. Recovery:
SSH to the host (unaffected), then remove the rules or use the direct LAN
path; the disable command is documented in `/boot/config/go`.

## Data handling

- `/app/data` holds the audit log and shared dashboards only — no secrets
  are stored by the app (API keys live in container env only).
- Diagnostics expose latency/reachability/counters/bytes — never secret
  material, tokens, or env values.
- Logs scrub credential-looking assignments before audit entries are
  written.

## Known limitations

- With `AUTH_MODE=disabled` (current), identity is not asserted on the
  direct-LAN path by design; the Authelia-protected proxy path is the
  identity-bearing path.
- The proxy path's allow-list blocks cloud IPs; remote access requires
  Tailscale (deliberate).
- Prometheus queries are built server-side from validated windows only;
  the browser cannot inject PromQL. Prometheus itself is unauthenticated
  on the LAN — out of scope for this app.
