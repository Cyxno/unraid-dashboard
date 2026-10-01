# Security

This document describes the security model, boundaries, and guarantees
behind Beacon. It is written for anyone running or evaluating the
project: nothing here assumes a specific deployment beyond what the
documentation describes.

## Reporting a vulnerability

Please report security issues privately rather than opening a public
issue:

- Use **GitHub → Security → Report a vulnerability** (private advisory)
  on this repository, or
- open a GitHub issue **without details** to request a private channel.

Include the Beacon version (`/api/version`), the affected surface
(page, API route or helper) and a minimal reproduction. Please do not
include real API keys, tokens or server addresses in any report.

See [README.md](../README.md#safety-and-permissions) for what Beacon
can and cannot do, and [docs/ROADMAP.md](ROADMAP.md) for known
limitations.

## Threat model

Self-hosted dashboard on an Unraid home server. Trusted zone: the local
network (e.g. `192.168.1.0/24`), the Unraid host itself, and any
private VPN peers you include. Untrusted: everything else (WAN, other
VLANs, the public internet). Two credentials exist server-side (a
VIEWER read key and a narrowly-scoped action key); neither ever reaches
the browser.

## Security boundaries

1. **Browser ↔ dashboard (BFF)**: the browser can only call this app's
   own routes. It can never run arbitrary PromQL, never sees API keys,
   and never talks to the Unraid API or Prometheus directly.
2. **Dashboard ↔ Unraid API**: read-only VIEWER key for all state;
   lifecycle mutations use a physically separate action key restricted
   to `DOCKER:UPDATE_ANY` (the only write permission Beacon needs).
3. **Dashboard ↔ host**: the container runs unprivileged (non-root),
   with **no Docker socket, no privileged mode, and no host shell
   access**. Its only host filesystem access is the narrow `/app/data`
   bind mount.
4. **Helper ↔ Docker**: the update helper is the ONLY component with
   Docker access (see Update management below).

## Authentication

`AUTH_MODE` drives identity handling:

- `disabled`: trusted-LAN behavior — every request is anonymous-local.
- `proxy`: the trust boundary is a **proxy-injected shared secret**
  (`AUTH_PROXY_SECRET` arriving as `X-Dashboard-Auth-Token` from your
  reverse proxy — e.g. Nginx Proxy Manager + Authelia — alongside the
  identity header). The API layer compares it in constant time and the
  page middleware enforces the same rule; **fail-closed** when unset.
  Forged `X-Forwarded-For` / identity headers from the LAN are
  worthless without the secret — the header-spoofing caveat of plain
  proxy auth is closed.

The dashboard never performs password auth and holds no user store.
Direct LAN access is treated as trusted-local: requests are accepted as
a fixed identity and client-supplied identity headers are ignored.

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
- **Update helper:** a dedicated single-purpose container — the only
  component with Docker access. Hard guarantees:
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
- **Compose service updates:** paths come only from the container's own
  compose labels, validated against deploy-time read-only root mounts
  (`COMPOSE_ALLOWED_ROOTS`); every invocation is a scoped argv array
  (`compose pull`/`up -d --no-deps <service>`).
- **Project updates:** the request names ONLY the project. Members,
  order and paths derive server-side from live labels plus
  `docker compose config`. Refused entirely for pipeline-owned projects,
  any HIGH-risk member (databases/auth/proxy/DNS), AIO/externally
  managed or non-recreatable members, and ambiguous dependency graphs
  (cycles, configured services without containers). Services update one
  at a time (dependencies first), health-validated, stopping on the
  first failure with the failed service rolled back. Project-level
  automation can therefore never bypass per-service risk policy — the
  helper re-derives every refusal even if the dashboard were bypassed.
- **Rollback readiness:** mutation requires a resolvable running image; a
  stored pre-update snapshot makes rollback *proven* (surfaces as
  rollback level `ready` vs `unproven`). Snapshots contain env values
  and are stored 0600 in the helper state dir; no endpoint ever returns
  their contents — only presence metadata.
- **Recovery actions:** the Operations page exposes only:
  create/validate resilience backup, restore dry-run, dependency-check
  retry, and clearing a stale PRE-mutation operation (the helper refuses
  post-mutation clears and verifies the target container is running).
  No generic shell, no arbitrary restore, no arbitrary image rollback.

## Pipeline-owned projects

Compose projects listed in `PIPELINE_OWNED_PROJECTS` or labeled
`com.cyxno.management=pipeline` are classified `pipeline_owned`: the
dashboard detects their update state for display but refuses every
mutation, at both the dashboard gate and the helper. Optional
declarative metadata (`com.cyxno.pipeline.repo/deployer/sha/ref`) is
display-only. `com.cyxno.update.policy`/`risk` labels are declarative
metadata that can only TIGHTEN policy (toward manual / higher risk) —
labels never loosen server-side classification.

## Network exposure

Beacon serves plain HTTP on its listen port. Recommendations:

- Keep direct access LAN-only (Unraid's default) and use a reverse
  proxy with SSO (`AUTH_MODE=proxy`) for anything beyond the LAN.
- Firewall the dashboard port to the networks you trust; the app's
  trusted-local model assumes the network is the boundary.
- Do not forward the dashboard port to the WAN.

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

- With `AUTH_MODE=disabled`, identity is not asserted on the direct-LAN
  path by design; the proxy path is the identity-bearing path.
- Prometheus queries are built server-side from validated windows only;
  the browser cannot inject PromQL. Prometheus itself is unauthenticated
  on the LAN — out of scope for this app.
- Auto-update is an opt-in pilot: eligibility is computed and displayed,
  but nothing schedules updates on its own; the pilot is allowlist-gated
  to LOW-risk containers with a proven rollback record.

## Machine API (Agent API)

The optional Agent API under `/api/agent/v1` is **read-only by
construction**: it exposes health, system, Docker inventory, issues,
projects, storage, operations and event-stream endpoints. There are no
POST/PUT/DELETE handlers in the entire route tree (enforced by test).
It requires its own bearer token (`AGENT_API_TOKEN`, min 32 chars,
constant-time compared, never logged) and is rate-limited per endpoint.
It may report capability *facts* (e.g. "docker start available") but
can never perform one.

## Action key

Lifecycle actions (container start/stop) require a dedicated
`UNRAID_ACTION_API_KEY` with only `DOCKER: UPDATE_ANY`. The key is
validated server-side, never echoed, never included in audit payloads,
and its presence alone enables the capability — validity is proven at
action time. Capabilities are recomputed live everywhere (Docker page,
container detail, Automation eligibility, Operations, Settings, Agent
API context), so a removed or invalidated key disables the surface
everywhere with no stale "Ready" state.

## Demo mode

Running Beacon against an unreachable Unraid API renders synthetic data
(badged **Demo data**). Mutations require a live Unraid API plus the
action key, so a demo instance is read-only by construction.
