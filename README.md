# Unraid Dashboard

A self-hosted, dark-first web dashboard for an Unraid server. The Next.js
server acts as a backend-for-frontend (BFF): it talks to the Unraid GraphQL
API and the browser never sees your API key.

## Purpose

Single pane of glass for the health of an Unraid box — CPU, memory, storage,
network throughput, Docker containers and notifications — deployable as one
container next to your server.

## Stack

- **Next.js 16** (App Router, standalone output) + **React 19**
- **TypeScript** (strict, `noUncheckedIndexedAccess`)
- **Tailwind CSS 4** + shadcn/ui-style components
- **Lucide** icons, **Recharts** charts, **zod** env validation
- Docker multi-stage build (non-root runtime, healthcheck)

## Environment variables

| Variable               | Required | Default     | Description                                                        |
| ---------------------- | -------- | ----------- | ------------------------------------------------------------------ |
| `UNRAID_URL`           | yes      | —           | Base URL of the Unraid API host (no `/graphql` suffix)             |
| `UNRAID_API_KEY`       | yes      | —           | Unraid API key — server-side only, never shipped to the browser    |
| `UNRAID_TIMEOUT_MS`    | no       | `10000`     | Timeout for Unraid API requests                                    |
| `UNRAID_GRAPHQL_PATH`  | no       | `/graphql`  | Path of the GraphQL endpoint appended to `UNRAID_URL`              |
| `DASHBOARD_PORT`       | no       | `3080`      | Host port published by docker-compose                              |

Variables are validated server-side with zod at first use; the process fails
fast with a clear message when they are missing. Copy `.env.example` to
`.env` for local development.

## Docker

```bash
docker build -t unraid-dashboard .

docker run -d --name unraid-dashboard \
  -p 3080:3000 \
  -e UNRAID_URL="http://tower.local" \
  -e UNRAID_API_KEY="your-api-key" \
  --restart unless-stopped \
  unraid-dashboard
```

Healthcheck endpoint: `GET /api/health` (returns `{"status":"ok"}`).

## docker compose deployment

```bash
cp .env.example .env   # fill in UNRAID_URL and UNRAID_API_KEY
docker compose up -d
```

The compose file publishes `${DASHBOARD_PORT:-3080}` on the host and maps it
to the container's port 3000. On an Unraid host you may prefer
`network_mode: host` so the dashboard can reach `http://127.0.0.1/graphql`
directly (then set `UNRAID_URL` accordingly).

## Unraid API setup

1. **Unraid 7.2+** has the API built in — enable it under
   *Settings → Management Access → API* (older versions need the Unraid
   Connect plugin, which serves the API on port `3005`).
2. Create an **API key** in the same panel with read access to the resources
   used here (metrics, array, docker, notifications).
3. Point `UNRAID_URL` at the server (e.g. `http://tower.local`) — the
   built-in API is served at `/graphql` on the WebGUI port; set
   `UNRAID_GRAPHQL_PATH` / port if your setup differs.

Field names in `src/server/unraid/queries.ts` are taken from the official
`generated-schema.graphql` in the [`unraid/api`](https://github.com/unraid/api)
monorepo, not guessed.

## Live data vs. placeholders

**Live (real Unraid API integration):**

- Server name, OS version, uptime (identity / services queries)
- CPU utilisation, memory utilisation (`metrics` query)
- Network RX/TX throughput + totals (`metrics.network`)
- Array state, capacity, per-disk usage, parity status (`array` query)
- Docker container list, states, update flags (`docker` query)
- Notification counts + recent warnings/alerts (`notifications` query)

**Placeholders / limitations:**

- The **resource history chart** is built from samples collected while the
  page is open (the API exposes point-in-time metrics only) — it starts
  empty on each visit.
- Per-container CPU/memory numbers are only populated in demo data.
- **Docker, Storage, VMs, Network, Logs, Settings** pages are navigation
  placeholders.
- No authentication yet; the data layer is isolated in `src/server` so
  auth middleware can be added without touching UI code.

When the Unraid API is unreachable, the dashboard serves clearly labelled
demo data: a **"Demo data"** badge appears in the header and a banner
explains which sections fell back. Live and fallback data can coexist per
section; nothing is silently presented as live.

## Project structure

```
src/
├── app/
│   ├── api/health/route.ts     # container healthcheck
│   ├── api/overview/route.ts   # BFF: aggregated overview snapshot
│   ├── page.tsx                # overview page
│   └── {docker,storage,vms,network,logs,settings}/page.tsx   # placeholders
├── components/
│   ├── dashboard/              # stat cards, chart, storage, docker, events
│   ├── layout/                 # sidebar, header, app shell, polling context
│   └── ui/                     # button, badge, card, progress, skeleton
├── hooks/use-overview.ts       # client polling + history accumulation
├── lib/                        # navigation config, formatting helpers
└── server/                     # server-only: never imported by client code
    ├── env.ts                  # zod validation of UNRAID_* variables
    └── unraid/
        ├── client.ts           # UnraidClient: fetch + timeout + error types
        ├── queries.ts          # GraphQL documents (verified field names)
        ├── mappers.ts          # raw GraphQL -> domain types
        ├── mock.ts             # clearly flagged demo data
        ├── overview.ts         # per-section aggregation with graceful fallback
        └── types.ts            # domain types shared with the UI
```

## Development

```bash
npm install
npm run dev         # http://localhost:3000
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm run build       # production build
```

## Deployment (Unraid)

The image is published to `ghcr.io/cyxno/unraid-dashboard` by GitHub Actions
(`.github/workflows/docker-publish.yml`) on every push to `main`:

- `latest` — tracks `main`
- `sha-<commit>` — per-commit traceability
- `X.Y.Z` — on `v*` tags

On Unraid, deploy via the **Docker tab → Add Container** using the
`my-unraid-dashboard` user template (host network mode, port 8090, restart
policy `unless-stopped`, Docker healthcheck built in). `UNRAID_URL` and
`UNRAID_API_KEY` are runtime-only configuration — the template stores them on
the flash drive (`/boot/config/plugins/dockerMan/templates-user/`, root-only
permissions) and they are never committed to the repository.

> Note: the GitHub repository is private, so GHCR images are private too.
> Run `docker login ghcr.io` on the host (with a PAT having `read:packages`)
> before pulling, or make the package public.
