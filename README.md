# Unraid Dashboard

A self-hosted, dark-first server console for Unraid. The Next.js server acts
as a backend-for-frontend (BFF): it polls the Unraid GraphQL API server-side
and the browser never sees your API key.

> **Screenshots** — *(placeholder: add screenshots here)*

## Features

- **Overview** — CPU / RAM / array / Docker / network / uptime summary cards
  with live values, CPU temperatures, a derived global health indicator
  (healthy / attention / critical, from real conditions only) and a rolling
  resource-history chart (5 min / 15 min / 1 hour windows).
- **Docker** — searchable, filterable, sortable table of all containers
  (state, parsed health, ports, update flags) with a read-only detail panel.
- **Storage** — array state, parity status, per-disk utilization, filesystem,
  temperature and Unraid disk-health colors; data-disk vs cache aggregates.
- **Network** — per-interface link state, IP, speed, live RX/TX rates and
  cumulative traffic; physical interfaces first, virtual ones opt-in.
- **System** — hostname, OS/kernel/arch, boot mode, CPU model and clocks,
  memory, board/system identity, temperatures.
- **VMs** — read-only list (name + state; the 7.3.2 API exposes only that).
- **Notifications** — unread/archive list with severity filters.
- **Logs** — read-only viewer for the files the Unraid API reports (tail,
  text filter, capped output).
- **Settings** — local-only preferences (refresh preset, temperature unit,
  table density, history window, virtual-interface visibility) plus a
  connection-status panel (target host, latency, key roles, last success).

## Architecture

```
Browser ── HTTP ──> Next.js server (BFF) ── GraphQL ──> Unraid API
                    ├─ env validation (zod)             (x-api-key header,
                    ├─ per-domain section cache          key never leaves
                    ├─ live / stale / unavailable / demo contract
                    ├─ in-memory metrics history (2h)
                    └─ DTO mapping (no raw GraphQL in responses)
```

- One `SectionProvider` per domain (metrics, identity, storage, docker,
  notifications, VMs, system, network) with a server-side TTL cache, so
  browser polls at different cadences cause at most one Unraid query per TTL.
- Every API response section carries a status: `live`, `stale` (last known
  good data retained after a failed refresh), `unavailable`, or `demo`
  (placeholder data only when the API has *never* responded since process
  start — clearly labelled in the UI).
- Metrics history is sampled server-side every ≥5 s, kept 2 h in memory, and
  served downsampled (≤360 points) for the requested window. **It resets when
  the container restarts** — it is not Unraid's own history.

## Tech stack

Next.js 16 (App Router, standalone output) · React 19 · strict TypeScript ·
Tailwind CSS 4 · shadcn-style components · Lucide icons · Recharts · zod ·
node:test + tsx for tests.

## Unraid requirements

- **Unraid 7.2+** with the API enabled (*Settings → Management Access → API*),
  or the Unraid Connect API plugin (serves on port `3005`).
- An **API key**. A **VIEWER role key is sufficient** for every feature of
  this dashboard — create one in the API panel or via
  `unraid-api apikey --create --name "unraid dashboard" --roles VIEWER`.
  No write/mutation permission is needed; the UI deliberately exposes no
  destructive actions.

## Environment variables

| Variable              | Required | Default    | Description                                                |
| --------------------- | -------- | ---------- | ---------------------------------------------------------- |
| `UNRAID_URL`          | yes      | —          | Base URL of the Unraid API host (no `/graphql` suffix)     |
| `UNRAID_API_KEY`      | yes      | —          | API key — server-side only, never sent to the browser      |
| `UNRAID_TIMEOUT_MS`   | no       | `10000`    | Timeout for Unraid API requests                            |
| `UNRAID_GRAPHQL_PATH` | no       | `/graphql` | Path appended to `UNRAID_URL` for the GraphQL endpoint     |
| `PORT`                | no       | `3000`     | HTTP port the server binds (Next.js standard)              |
| `TZ`                  | no       | —          | Container timezone                                         |

Variables are validated server-side with zod; the process fails fast with a
clear message when required values are missing. Copy `.env.example` for local
development.

## Docker deployment

```bash
docker build -t unraid-dashboard .

docker run -d --name unraid-dashboard \
  -p 8090:3000 \
  -e UNRAID_URL="http://tower.local" \
  -e UNRAID_API_KEY="your-api-key" \
  --restart unless-stopped \
  unraid-dashboard
```

Healthcheck: `GET /api/health` (built into the image's Docker `HEALTHCHECK`).

## Unraid DockerMan deployment

A user template (`my-unraid-dashboard`) is installed on the target host. To
recreate it on another Unraid box, use the Docker tab → *Add Container*, set
the repository to `ghcr.io/cyxno/unraid-dashboard:latest`, and configure:

- **Network**: `host` (see *Why host networking* below)
- **Web UI port**: `8090` (env `PORT=8090`)
- `UNRAID_URL` / `UNRAID_API_KEY` as runtime variables (masked in the
  template; stored only on the flash drive, never committed to git)
- Extra args: `--restart=unless-stopped`

The image is non-root, has no volumes (nothing persistent is required) and
contains no secrets.

## GHCR images

GitHub Actions (`.github/workflows/docker-publish.yml`) builds and pushes on
every push to `main` and on `v*` tags:

- `ghcr.io/cyxno/unraid-dashboard:latest` — tracks `main`
- `ghcr.io/cyxno/unraid-dashboard:sha-<commit>` — per-commit
- `ghcr.io/cyxno/unraid-dashboard:X.Y.Z` — on `vX.Y.Z` tags

The repo is private, so images are **private**. On the Unraid host run
`docker login ghcr.io` with a PAT that has `read:packages` before pulling —
do not embed tokens anywhere in the repository.

## Why this deployment uses host networking and 127.0.0.1:442

On the target host the WebGUI stack (nginx) only binds the LAN IP and
localhost, and the built-in API is proxied through it. In practice:

- Node's `fetch` refuses port `79` (the plain-HTTP WebGUI port) as a
  well-known "bad port", and the HTTPS port serves a self-signed certificate
  on the LAN interface that would require disabling TLS verification.
- The clean, verified option is therefore `--network host` with
  `UNRAID_URL=http://127.0.0.1:442` — nginx's plain-HTTP API proxy on
  localhost. No TLS is terminated or bypassed by the dashboard, no host
  config is changed, and the API key still never leaves the process.

A bridged deployment works fine against a standard `http://tower:PORT` API
endpoint — host networking is only needed for this host-local proxy setup.

## Live vs demo behavior

- With a reachable API and a VIEWER key, everything above is **live** data.
- If a section refresh fails, the UI keeps the **last known good data**,
  marks it **stale** (with the failure reason), and keeps retrying. It never
  blanks out or substitutes fake values during an outage.
- Only if the API has **never** responded since the dashboard process started
  does the UI show clearly labelled **demo** data (banner + per-section
  badges) so a fresh install still renders.

## Development

```bash
npm install
npm run dev         # http://localhost:3000
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx (mappers, health, history, sections)
npm run build       # production build
```

Queries in `src/server/unraid/queries.ts` are verified against the live API
on Unraid 7.3.2 by introspection. `VmDomain` exposes only `id`, `name`,
`state` on this version; container health is parsed from Docker's status
string because the API does not expose a health field; no per-container
CPU/memory stats are exposed, so none are shown.

## Security model

- The API key lives only in the server process (env var) — it is never
  returned by any API route, never placed in client bundles, and never logged.
- The browser talks only to the dashboard's own routes, which return typed
  DTOs (no raw GraphQL pass-through).
- Container detail intentionally omits environment variables (secret values).
- The log viewer only opens paths reported by the Unraid API's own
  `logFiles` list, with output capped at 1,000 lines.
- No Docker socket mount, no privileged mode, no host filesystem mounts,
  no database, no authentication (deploy on a trusted LAN or put it behind
  your reverse proxy's auth).

### Known limitations

- Metrics history is per-process memory; container restarts reset it.
- VM details are limited by the API schema (name/state only).
- Docker container health is derived from status text (works with Docker's
  healthchecks; containers without one show no health badge).
- No auth: run it on a trusted network.
- GHCR images are private while the repo is private.

## Roadmap

- Container lifecycle actions (start/stop/restart) behind explicit
  confirmation, requiring a broader-permission key
- Optional history persistence (e.g. SQLite or Prometheus remote-write)
- CPU per-core chart, disk I/O series
- Auth (SSO/reverse-proxy header trust)
- PWA manifest + offline shell

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Header shows **Demo data** | `UNRAID_URL`/`UNRAID_API_KEY` wrong or API disabled. Check the API panel; test `curl -H "x-api-key: …" $UNRAID_URL/graphql -d '{"query":"{ online }"}' -H 'content-type: application/json'`. |
| Sections marked **Stale** | The API stopped answering; data is last-known-good. Check the Unraid API process / network. |
| `Invalid server environment configuration` on boot | Missing `UNRAID_URL` or `UNRAID_API_KEY`. |
| 401/`Unauthorized` responses | API key invalid or revoked; recreate the VIEWER key. |
| Chart empty for the first minutes | History builds while the dashboard runs; it starts empty after each container start by design. |
