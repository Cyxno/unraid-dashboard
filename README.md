# Unraid Dashboard

A self-hosted, dark-first server console for Unraid. The Next.js server acts
as a backend-for-frontend (BFF): it polls the Unraid GraphQL API and a
Prometheus server server-side, and the browser never sees your API key or a
raw metric payload.

> **Screenshots** — *(placeholder: add screenshots here)*

## Features

- **Overview** — CPU / RAM / array / Docker / network / uptime cards with live
  values, CPU load + package temperature (with 1-hour peak), per-interface RX/TX
  (primary physical interface), disk throughput, unhealthy/high-memory container
  counts, a **Top consumers** widget (CPU/Memory tabs), a derived health banner
  (real conditions only — no invented score) and a Prometheus-backed resource
  history chart.
- **Docker** — searchable, filterable, sortable table of all containers with
  live CPU% and memory columns (from Prometheus), compose-project grouping,
  high-CPU / high-memory filters, and a read-only detail panel with per-container
  CPU + memory history charts.
- **Storage** — array state, parity, per-disk utilization/temperature/health
  colors (Unraid) plus a separate **Disk activity** section: per-device read/
  write MB/s and IOPS, aggregate throughput, and 15m–24h performance history.
- **Network** — per-interface link state, IP, speed, live RX/TX and cumulative
  counters (Unraid), plus per-interface and aggregate throughput **history**
  (Prometheus). Docker bridges/veths are excluded so bytes are never
  double-counted.
- **System** — platform identity (Unraid) and a full observability section:
  instant CPU/load/RAM/thermal/power snapshot, per-core CPU grid (collapsed
  summary, sortable, expandable), and tabbed history charts (CPU incl. per-core
  breakdown, Memory, Load, Network, Disk I/O, Temperatures) over 5m–7d windows
  with per-sensor min/max tables.
- **VMs** — read-only list (name + state; the 7.3.2 API exposes only that).
- **Notifications** — unread/archive list with severity filters.
- **Logs** — read-only viewer for the files the Unraid API reports.
- **Settings** — local preferences (refresh preset, temperature unit, density,
  default history window 5m–7d, per-core visibility, Docker metric columns,
  virtual interfaces), a **Diagnostics** panel (Unraid + Prometheus reachability,
  latencies, last-success times) and **About** (version, git SHA, build time).

## Architecture

```
Browser ── HTTP ──> Next.js server (BFF) ──┬── GraphQL ──> Unraid API
                                           │               (x-api-key, VIEWER)
                                           └── HTTP ────> Prometheus (node-exporter,
                                                (read)     cAdvisor, homelab-exporter,
                                                           docker-stats textfile)
```

**Responsibilities are split deliberately:**

| Source | Authoritative for |
| --- | --- |
| Unraid GraphQL | identity, array state, disks (incl. temperatures), Docker lifecycle state (running/stopped/health/update), VMs, notifications, logs, interface metadata (IP/MAC/DHCP) |
| Prometheus | CPU (total + per-core), load, memory breakdown (incl. swap), thermal sensors, platform power, network throughput + history, disk I/O + history, per-container CPU/memory + history, all range history |
| Derived | health derivation, thread-relative load levels, container limit heuristics |

- Unraid state never depends on Prometheus. If Prometheus is down, lifecycle
  state, capacity, notifications and logs stay live; Prometheus-derived widgets
  show "unavailable" with a reason. **No fabricated or demo data is ever
  substituted.**
- History (5m / 15m / 1h / 6h / 24h / 7d) comes from Prometheus range queries —
  it survives dashboard restarts because Prometheus holds the data. Step sizes
  are chosen per window (10s → 1h) so charts get 30–170 points, and each
  (metric, window) result is cached server-side (5s → 5min). While Prometheus
  is unreachable, the Overview chart falls back to the small in-memory buffer
  and is labelled as such.
- Every Prometheus-derived payload carries provenance: `source`, `status`
  (`live` / `stale` / `unavailable`), `sampledAt`, and a `reason` when degraded.
- Unraid domains use one `SectionProvider` each with a server-side TTL cache
  (browser polls never translate into more than one Unraid query per TTL).

### Data sources on this host (verified, not assumed)

| Exporter | Job | What the dashboard uses |
| --- | --- | --- |
| node-exporter `:9100` | `node` | CPU, load, memory, swap, network, disk I/O, filesystems, hwmon |
| textfile collector (docker-stats-textfile, 15s loop) | `node` | `docker_stats_*` gauges per container name (CPU%, mem, limit) |
| homelab-exporter `:9919` | `homelab` | `homelab_temperature_celsius{chip,sensor}` (coretemp package + per-core, acpitz), `homelab_power_watts{zone="psys"}` |
| cAdvisor `:8080` | `cadvisor` | **not used** for name-keyed metrics — this install exposes only cgroup-`id` labels (no name/image), so it cannot be joined reliably |

Prometheus scrapes every 15s (default retention covers the 7-day window).

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
- **Optional:** a Prometheus server reachable from the dashboard container
  (e.g. `http://127.0.0.1:9090` with host networking). Without it the
  dashboard still serves all Unraid state and marks Prometheus-derived
  widgets unavailable.

## Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `UNRAID_URL` | yes | — | Base URL of the Unraid API host (no `/graphql` suffix) |
| `UNRAID_API_KEY` | yes | — | API key — server-side only, never sent to the browser |
| `PROMETHEUS_URL` | no | — | Prometheus base URL for time-series metrics/history/thermals |
| `PROMETHEUS_TIMEOUT_MS` | no | `5000` | Timeout for Prometheus requests |
| `UNRAID_TIMEOUT_MS` | no | `10000` | Timeout for Unraid API requests |
| `UNRAID_GRAPHQL_PATH` | no | `/graphql` | Path appended to `UNRAID_URL` |
| `PORT` | no | `3000` | HTTP port the server binds |
| `TZ` | no | — | Container timezone |
| `APP_VERSION` / `GIT_SHA` / `BUILD_TIME` / `IMAGE_REF` | no | — | Build provenance, injected by the Dockerfile / GHCR workflow; exposed via `/api/version` |

Variables are validated server-side with zod; the process fails fast when
required values are missing. Copy `.env.example` for local development.

## Docker deployment

```bash
docker build -t unraid-dashboard .

docker run -d --name unraid-dashboard \
  -p 8090:3000 \
  -e UNRAID_URL="http://tower.local" \
  -e UNRAID_API_KEY="your-api-key" \
  -e PROMETHEUS_URL="http://127.0.0.1:9090" \
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
- `PROMETHEUS_URL` (e.g. `http://127.0.0.1:9090`)
- Extra args: `--restart=unless-stopped`

The image is non-root, has no volumes (nothing persistent is required) and
contains no secrets.

## GHCR images

GitHub Actions (`.github/workflows/docker-publish.yml`) builds and pushes on
every push to `main` and on `v*` tags:

- `ghcr.io/cyxno/unraid-dashboard:latest` — tracks `main`
- `ghcr.io/cyxno/unraid-dashboard:sha-<commit>` — per-commit
- `ghcr.io/cyxno/unraid-dashboard:X.Y.Z` — on `vX.Y.Z` tags

Build provenance (`APP_VERSION`, `GIT_SHA`, `BUILD_TIME`) is injected as
build args and surfaced at `/api/version`, in Settings → About and the footer.

### Private-registry login (one-time per host)

The package is **private**, so anonymous pulls fail with `unauthorized`.
Authenticate the host once with a PAT that has **`read:packages`** (minimum):

```bash
scripts/login-ghcr.sh        # prompts for the token (hidden), then verifies a pull
```

Docker persists the credential in the daemon's config (on Unraid:
`/boot/config/plugins/dockerMan/config.json`), so it survives reboots.
Never commit or embed the token anywhere.

### Safe updates

`scripts/update-dashboard.sh` (on the host) pulls the target image, recreates
the container with its previous env (including the API key), network mode,
port and restart policy, waits for the healthcheck, verifies `/api/overview`
answers, and **rolls back automatically** to the previous image if anything
fails:

```bash
scripts/update-dashboard.sh                                  # same tag (refresh)
scripts/update-dashboard.sh ghcr.io/cyxno/unraid-dashboard:0.3.0
```

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

Host networking also lets the dashboard reach Prometheus on
`http://127.0.0.1:9090` (the container's published port) without exposing
anything new. A bridged deployment works fine against a standard
`http://tower:PORT` API endpoint — host networking is only needed for this
host-local proxy setup.

## Live / stale / degraded behavior

- With a reachable API and a VIEWER key, Unraid state is **live**.
- If a section refresh fails, the UI keeps the **last known good data**,
  marks it **stale** (with the failure reason), and keeps retrying. It never
  blanks out or substitutes fake values during an outage.
- Only if the API has **never** responded since the dashboard process started
  does the UI show clearly labelled **demo** data.
- If Prometheus is unreachable, all Prometheus-derived widgets show
  **unavailable/stale** with a reason, container lifecycle state stays live
  (Unraid), and the health banner notes "Prometheus unavailable — live
  metrics degraded". The dashboard never marks itself fully offline just
  because Prometheus is down.

## Thresholds

All judgment thresholds live in one documented module:
`src/server/thresholds.ts` (CPU/load/memory pressure, package/board
temperatures, container high-CPU/high-memory, the docker-limit heuristic).
Load is classified only relative to CPU thread count (`normal` / `elevated` /
`high`), never against arbitrary absolutes. The Docker-page filter presets
mirror the same constants and show them in tooltips.

## Development

```bash
npm install
npm run dev         # http://localhost:3000
npm run lint        # eslint
npm run typecheck   # tsc --noEmit
npm test            # node:test via tsx (parsing, joins, health, windows, provenance)
npm run build       # production build
```

Queries in `src/server/unraid/queries.ts` and PromQL in
`src/server/prometheus/queries.ts` are verified against the live services on
this host (Unraid 7.3.2; Prometheus with node-exporter, cAdvisor,
homelab-exporter and the docker-stats textfile collector). Do not add fields
or selectors without re-verifying.

## Security model

- The API key lives only in the server process (env var) — it is never
  returned by any API route, never placed in client bundles, and never logged.
- Prometheus is queried server-side with fixed PromQL built from validated
  window/enum/container-name parameters. **No arbitrary PromQL endpoint
  exists**; container-name input is validated against Docker's name grammar
  and interpolated server-side as a string literal.
- The browser talks only to the dashboard's own routes, which return typed
  DTOs (no raw GraphQL or raw Prometheus payloads).
- Container detail intentionally omits environment variables (secret values).
- The log viewer only opens paths reported by the Unraid API's own
  `logFiles` list, with output capped at 1,000 lines.
- `/api/version` and `/api/diagnostics` expose only whitelisted values
  (version, SHA, target hostnames, latencies) — never credentials.
- No Docker socket mount, no privileged mode, no host filesystem mounts,
  no database, no mutation or command-execution endpoints, no authentication
  (deploy on a trusted LAN or put it behind your reverse proxy's auth).

### Known limitations

- Per-container network I/O is not shown: the local cAdvisor exposes no
  name/image labels, so per-container network metrics cannot be joined
  reliably. Container CPU/memory come from the docker-stats textfile gauges.
- Container restart counts are not exposed by any current source (Unraid API
  and docker-stats textfile do not provide them); uptime is shown via the
  Unraid status string.
- Thermal coverage = CPU package + per-core (coretemp), ACPI/motherboard
  zone and platform power. **No fan RPM or NVMe sensors** are exposed by any
  exporter on this host. Disk temperatures come from Unraid (Storage page).
- Thermal-throttle counters are not exposed by node-exporter on this host,
  so no throttle events are shown (cumulative counters would be misleading
  and none exist to misrepresent).
- cAdvisor is not used for name-keyed metrics (id-only labels, see above).
- VM details are limited by the API schema (name/state only).
- Docker container health is derived from status text (works with Docker's
  healthchecks; containers without one show no health badge).
- No auth: run it on a trusted network.
- GHCR images are private while the repo is private.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Header shows **Demo data** | `UNRAID_URL`/`UNRAID_API_KEY` wrong or API disabled. Check the API panel; test `curl -H "x-api-key: …" $UNRAID_URL/graphql -d '{"query":"{ online }"}' -H 'content-type: application/json'`. |
| Sections marked **Stale** | The API stopped answering; data is last-known-good. Check the Unraid API process / network. |
| `Invalid server environment configuration` on boot | Missing `UNRAID_URL` or `UNRAID_API_KEY`. |
| 401/`Unauthorized` responses | API key invalid or revoked; recreate the VIEWER key. |
| Charts / container CPU/memory / thermals show **unavailable** | `PROMETHEUS_URL` unset, wrong, or Prometheus is down. Check Settings → Diagnostics (reachability + latency) and `curl http://127.0.0.1:9090/-/healthy`. Unraid state pages remain usable either way. |
| Metric history starts mid-window | Prometheus holds the history; the dashboard only serves what Prometheus has. A freshly-scraped exporter or short retention limits long windows. |
| **Missing container metrics** (2 of N containers) | docker-stats only reports *running* containers; stopped ones have no rows by design. |
| **Mismatched container names** in metrics | The textfile collector joins by container name; names with unusual characters could diverge — check `docker stats --no-stream` output vs the name shown. |
| **No temperature sensors** | homelab-exporter must be up and scraped (job `homelab`). Without it, the dashboard falls back to the `x86_pkg_temp` thermal zone; with neither, thermal cards show "no sensors". |
| **No disk I/O metrics** | node-exporter must expose `node_disk_*` for physical devices (sdX/nvme). The array layer (md*) is deliberately excluded to avoid double counting. |
| Metrics stale after clock jump | Prometheus data older than ~90s is treated as stale; check exporter/daemon uptime. |

## Roadmap

- Container lifecycle actions (start/stop/restart) behind explicit
  confirmation, requiring a broader-permission key
- Per-container network charts if cAdvisor gets name labels (or via
  eBPF exporters)
- Auth (SSO/reverse-proxy header trust)
- PWA manifest + offline shell, NOC mode, saved compare sets
