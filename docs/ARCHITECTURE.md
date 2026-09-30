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

## Trust boundaries

1. Browser → Beacon: same-origin; proxy-auth secret or trusted-LAN model.
2. Beacon → Unraid: read-only VIEWER key (dashboards) / narrow action key
   (lifecycle, optional).
3. Beacon → helper: bearer token, localhost.
4. Beacon → Prometheus: read-only queries; the browser can never run PromQL.
5. Agent API: separate bearer token, read-only route tree (test-enforced).

## Key source files

- `src/server/auth/` — auth resolution, guards (read/write/delete)
- `src/server/unraid/` — queries, mappers, section providers
- `src/server/actions/` — guarded action pipeline + audit
- `src/server/update/` — helper client, release chain, eligibility
- `src/server/automation/` — scheduler, policy, capability context
- `src/server/prometheus/` — metrics clients, thermal intelligence
- `src/components/actions/` — shared verified-action controller
- `scripts/visual-regression.mjs` — visual + semantic layout gates
