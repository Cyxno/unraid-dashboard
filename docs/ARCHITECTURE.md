# Architecture

```
                        ┌──────────────────────────────┐
                        │           Browser            │
                        │  Next.js App Router UI (PWA) │
                        └──────┬───────────────▲───────┘
              same-origin only │               │ SSE live events,
              cookies/headers  │               │ toasts, poll fallback
                        ┌──────▼───────────────┴───────┐
                        │        Beacon (BFF)          │
                        │  Next.js server, unprivileged│
                        │  no Docker socket, no shell  │
                        └──┬───────┬───────┬───────┬───┘
            read-only key  │       │       │       │  update requests
        ┌──────────────────▼─┐   ┌─▼───────▼────┐  └──▶ Beacon update helper
        │  Unraid GraphQL API│   │  Prometheus  │       (separate container,
        │  (array, docker,   │   │ (metrics,    │        ONLY component with
        │   vms, network…)   │   │  history)    │        the Docker socket)
        └────────────────────┘   └──────────────┘
                        │
                        ▼
                GHCR (release verification: digest match)
```

## Components

- **Beacon app** (this repo): Next.js App Router, React 19, Tailwind v4.
  Acts as a backend-for-frontend: the browser talks only to this app.
- **Unraid GraphQL API**: all server state (array, disks, Docker inventory,
  VMs, network, notifications). Accessed with a read-only key.
- **Prometheus** (optional): runtime metrics, history series, package
  temperature/power, per-container CPU. Read-only queries.
- **Update helper** (optional, separate container): the only component with
  Docker-socket access. Pulls images, verifies digests, recreates containers,
  rolls back. Communicates with Beacon over localhost + bearer token.
- **GHCR**: release artifacts. Updates verify `repoDigest == registryDigest`
  before replacing the container.

## Data flow patterns

- **Polling with SSE acceleration**: every page owns its polling cadence; the
  SSE stream (`/api/events`) pushes compact snapshots (docker counts, state
  transitions, health, automation evaluations). SSE never carries the
  authoritative state — it accelerates it.
- **Section providers + TTL caches** server-side: browser polls at any cadence
  translate into at most one Unraid query per TTL per domain.
- **Lazy secondary sections**: the Docker page mounts Updates/Projects/History
  panels only when expanded — page entry never triggers a registry sweep.
- **Verified mutations**: POST → guarded (auth + same-origin + cooldown +
  rate limit) → audited → state transition observed (SSE event or bounded
  poll) → success only after authoritative state confirmation.
- **Incident intelligence (v1.5.0)**: every fetch path reports attempts into
  a source-health registry; the incident engine evaluates deterministic
  rules over the ALREADY-CACHED overview data on the same cadence — no new
  pollers. Incidents carry evidence (direct/derived/correlated), source,
  freshness, impact and a bounded timeline, persist to `/app/data`
  (atomic, bounded history) and feed the Overview verdict, the Incident
  Center, Web Push and diagnostics from ONE model. Source outages yield a
  single root incident with an impact list; dependent values read UNKNOWN,
  never zero, and never cascade into per-entity problems.

## Trust boundaries

1. Browser → Beacon: same-origin; proxy-auth secret or trusted-LAN model.
2. Beacon → Unraid: read-only VIEWER key (dashboards) / narrow action key
   (lifecycle, optional).
3. Beacon → helper: bearer token, localhost.
4. Beacon → Prometheus: read-only queries; the browser can never run PromQL.
5. Agent API: separate bearer token, read-only route tree (test-enforced).
6. Support bundles: built server-side from provenance-only fields and run
   through a redaction scrubber (key/value patterns, JWTs, long tokens,
   push endpoints) — credential-shaped material cannot leave the process.

## Key source files

- `src/server/auth/` — auth resolution, guards (read/write/delete)
- `src/server/unraid/` — queries, mappers, section providers
- `src/server/incidents/` — v1.5.0 incident engine: source health,
  freshness, evidence, rules, lifecycle, persistence, support bundle
- `src/server/insights/` — v1.6.0 operational intelligence: trend layer
  (bounded aggregates, quality/gap handling), capacity forecasts with
  confidence gating, deterministic anomaly statistics (memory creep,
  CPU drift, thermal baseline), recurrence and source-performance
  analysis. Prometheus stays the history source; Beacon persists only
  bounded insight identity
- `src/server/actions/` — guarded action pipeline + audit
- `src/server/remediation/` — v1.7.0 safe remediation: canonical action
  catalog (safe/guarded/manual-only), deterministic runbooks, the
  persisted operation registry (explicit lifecycle, conflicts, timeouts),
  live precondition re-checks and post-action verification. NO new
  mutations: guarded actions wrap the existing confirmed pipelines only
- `src/server/update/` — helper client, release chain, eligibility
- `src/server/automation/` — scheduler, policy, capability context
- `src/server/prometheus/` — metrics clients, thermal intelligence
- `src/components/actions/` — shared verified-action controller
- `scripts/visual-regression.mjs` — visual + semantic layout gates
