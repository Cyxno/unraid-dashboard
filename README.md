# Unraid Dashboard

A self-hosted, dark-first server console for Unraid — an installable PWA with
server-shared dashboard layouts. The Next.js server acts
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
  virtual interfaces), **shared dashboards** (server-persisted layouts with
  import/export), a **Diagnostics** panel (Unraid + Prometheus reachability,
  latencies, last-success times, PWA/service-worker state, self-monitoring
  and persistence health) and **About** (version, git SHA, build time,
  registry update status).

## Lifecycle actions (v0.4)

The dashboard can perform **verified, narrowly-scoped lifecycle actions**:
Docker start/stop and VM start/stop. Everything else (delete, recreate,
exec, prunes, image updates) is deliberately not implemented.

**Two-key model** — read and write are physically separate credentials:

| Key | Role/permissions | Powers |
| --- | --- | --- |
| `UNRAID_API_KEY` | VIEWER | every read: state, metrics, logs, notifications |
| `UNRAID_ACTION_API_KEY` | GUEST + `DOCKER:UPDATE_ANY,VMS:UPDATE_ANY` | docker start/stop, vm start/stop — **nothing else** (reads are denied to this key) |

Create the action key once on the host:

```bash
unraid-api apikey --create --name "unraid dashboard actions" \
  --roles GUEST --permissions "DOCKER:UPDATE_ANY,VMS:UPDATE_ANY"
```

Actions are **disabled unless both** `ENABLE_ACTIONS=true` **and** the action
key are configured. The action subsystem failing or being disabled never
affects read-only observability.

**Verified against the live API**: the dashboard ships only mutations that
were probed on the actual Unraid host. On Unraid 7.3.2 (API v4.10.0) that is
`docker.start`, `docker.stop`, `vm.start`, `vm.stop` — `docker.restart` does
not exist in this API version and is therefore NOT offered (the GitHub
schema is newer than the deployed API; the dashboard follows the live host).

**Guards**: every action requires an explicit confirmation dialog
(start = light, stop = strong with downtime warning), is validated against
the live inventory (unknown targets refused), is rate-limited (12/min per
user) with a 10s per-target cooldown, rejects concurrent actions on the
same target, and is written to the audit log **on every attempt**. Success
is reported only after the resulting state is verified — no optimistic UI.

**Audit log**: append-only JSONL in `/app/data` (rotate at 2 MiB, 4 rotated
files kept). Mount a narrow host path for persistence:
`-v /mnt/user/appdata/unraid-dashboard:/app/data`. Viewable in the
dashboard under **Audit**. Entries contain actor, source IP, action, target,
result, duration and a scrubbed error summary — never credentials.

## Authentication (v0.4)

`AUTH_MODE` controls access:

- `disabled` (default): trusted-LAN behavior, identical to v0.3.
- `proxy`: requests must arrive via your reverse proxy. Pages are served
  only when the configured identity header (`AUTH_HEADER`, e.g.
  `X-Forwarded-User`) is present — the proxy injects it after its own
  authentication (e.g. Authelia); direct requests get 401. Every API route
  enforces the same policy, `AUTH_ALLOWED_USERS` optionally restricts
  identities, and all write endpoints additionally enforce same-origin
  (CSRF) and JSON content-type.

**Nginx Proxy Manager pattern**: proxy a host (e.g. `unraid.example.com`)
to `http://192.168.1.2:8090`, enable its Access List (basic auth or your SSO),
and add an Advanced custom Nginx directive that OVERWRITES the identity
header so clients cannot spoof it:

```nginx
proxy_set_header X-Forwarded-User "remco";
proxy_buffering off; # required for the SSE stream
```

Set `AUTH_MODE=proxy`, `AUTH_HEADER=X-Forwarded-User`,
`AUTH_ALLOWED_USERS=remco` (optional), and `PUBLIC_BASE_URL`
(e.g. `https://unraid.example.com`) so CSRF origin checks accept the
external hostname, and keep the firewall rule so port 8090 stays
LAN/proxy-only.

> **Trust model**: self-hosted Next.js cannot see the socket peer address,
> so proxy mode assumes the dashboard port is only reachable by the proxy
> (firewall/binding). Without that network separation, LAN clients could
> forge headers. Settings → Security shows the active mode.

## Mobile UI (v0.5)

Phones are a first-class target. Below the `md` breakpoint the dashboard
switches to a dedicated mobile shell:

- **Bottom navigation** (Overview / Docker / Storage / System / More) with
  `env(safe-area-inset-bottom)` respected; "More" opens a bottom sheet with
  every page. The desktop sidebar remains unchanged.
- **Docker** renders a card list (name, state, CPU, memory, project, badges)
  instead of the desktop table; filter chips scroll horizontally, sort
  controls wrap, and every card opens the full detail page.
- **Container detail** shows 2-column metric tiles, chart-window switcher,
  and collapsible configuration sections; the Actions section keeps its
  explicit confirmation flow.
- **Logs** stack the file list above the viewer on phones (wrapping controls,
  internal line scrolling only); **Settings** rows wrap; **NOC mode** is a
  vertically scrollable wallboard on phones and enters fullscreen/wake-lock
  where supported.
- Validation: automated overflow + interaction checks at 320, 360, 375, 390,
  430 px portrait, 844×390 landscape, 1024 tablet and 1440 desktop.

## Realtime updates (v0.5)

`GET /api/events` is a Server-Sent Events stream backed by **one shared
server-side sampler** (never per-browser polling). Events: `snapshot`
(CPU/RAM/load/package temp, 5s), `docker` counts, `health` changes,
`state-transition` observations, `notifications` counts. Same auth policy as
every route (proxy mode enforced), same-origin only, heartbeats keep proxies
from idling, and disconnects clean up their subscription.

The client (`useDashboardEvents`) reconnects with bounded backoff, recovers
after device sleep, and **never becomes a dependency**: if SSE is down the
dashboard keeps REST polling (the overview poll stretches 3× only while SSE
is healthy). Connection loss/recovery and observed container state changes
surface as restrained toasts — never per-metric spam.

## Thermal analysis & diagnostics (v0.5 → v0.6)

System → Temps shows a 24h thermal analysis computed from Prometheus:
current, 5m average, 1h/24h max, 24h median and average, and approximate
minutes at/above the warning (80 °C) and critical (90 °C) thresholds
(`sum_over_time` of a bool comparison at 1-minute resolution). The current
reading is classified as **normal / elevated / spike / sustained-high /
critical** by comparing it with the 5-minute average — a one-sample peak is
labelled a spike, never sustained pressure. This host exposes no thermal
throttle counters, so nothing here implies throttling.

## Notification archive (v0.5)

Unread notifications can be archived from the dashboard (reversible in
Unraid via "unread"). The action uses the same narrowly-scoped action key,
validates the target against the live unread list, requires confirmation,
and writes an audit entry. Delete is not implemented.


## Installable PWA (v0.6)

The dashboard is a fully installable PWA — no external CDNs, every asset
bundled:

- **Manifest**: `/manifest.webmanifest` (name "Unraid Dashboard", standalone
  display, dark theme `#1c1c22`, portrait/landscape, any + maskable icons
  generated from `public/icon-source.svg` via `scripts/generate-icons.mjs`).
- **iOS**: Share → *Add to Home Screen* gives a full-screen app with
  black-translucent status bar. `viewport-fit=cover` + `env(safe-area-inset-*)`
  keep the header, sidebar and bottom nav clear of the notch/home indicator;
  heights use `svh`/`dvh` (never raw `100vh`), so the classic mobile
  URL-bar bug does not apply. Landscape insets are handled too.
- **Install UX**: quiet, never nagging — a hint lives in Settings → About
  ("Install as app") with the native prompt where the browser offers one and
  iOS-specific guidance where detectable. No first-visit modal.
- Diagnostics shows service-worker state, standalone/browser mode and
  network state.

### Service worker strategy

`/sw.js` is deliberately conservative — app-shell resilience, **never**
fake offline data:

- Precached: the navigation shell (`/`), manifest and bundled icons.
- Runtime-cached: immutable `/_next/static/*` chunks and static assets
  (cache-first, bounded to 120 entries).
- Navigations: network-first; offline → the cached shell is served and the
  app renders a blocking **offline banner** labelling all data as stale.
- `/api/*` is **never cached** (not even failures); live data, SSE, actions
  and audit state always hit the network. Non-GET requests are never
  intercepted, stored or replayed. Cross-origin requests are ignored.
- **Updates**: a new worker installs but waits; the app shows an "Update
  ready — refresh" banner and activates it only on user action (never
  mid-action, never auto-reload).

### Offline / disconnected UX

- Global banner while offline: "Offline — showing last known state.
  Server data unavailable; lifecycle actions disabled."
- Polling pauses (no pointless retries) and fires one refresh the moment
  connectivity returns; SSE stops retrying offline and reconnects on the
  browser `online` event; lifecycle actions are refused client-side —
  nothing is queued or replayed.

## Shared dashboards (v0.6)

Saved views can now live on the server and be shared across devices:

- **Storage**: one JSON file per dashboard under `DASHBOARDS_DIR` (default
  `/app/data/dashboards`) — the same narrow app-data volume as the audit
  log. No database. Atomic writes (0600), schema-versioned, backup before
  migration, future versions are never touched.
- **Schema** (strictly validated server-side, unknown fields stripped on
  input): `schemaVersion, id (opaque 12-char), name, owner, layout
  (widget order + visibility), preferences (history window, density, temp
  unit, refresh, docker metrics, per-core, docker filter), createdAt,
  updatedAt`. Limits: 50 dashboards, 64 KiB per dashboard, allowlisted
  widget ids only, bounded strings. No secrets can be stored — the schema
  cannot represent them.
- **Local vs shared**: local views stay in localStorage; shared dashboards
  are labelled "Shared — server" in the Views menu. **Nothing is uploaded
  automatically** — a local view becomes shared only via its explicit
  upload action. Save as local / save as shared / duplicate / rename /
  delete are all available.
- **Shareable links**: `/dashboard/<id>` renders a shared layout read-only
  (widget order/visibility, default window, docker filter applied). Ids are
  opaque and path-validated; no state is encoded in URLs.
- **Import/export**: Settings → Shared dashboards exports all shared
  layouts as sanitized JSON and imports validated files (size-bounded,
  unknown fields stripped, per-entry rejection with reasons).
- **Ownership**: with `AUTH_MODE=proxy` the authenticated proxy identity
  owns the dashboards it creates and only the owner may modify them. With
  auth disabled (trusted-LAN mode, the current deployment), shared
  dashboards are **trusted-LAN shared resources**: everyone on the trusted
  network can manage them and no accounts are invented. Both mutations are
  audit-logged.

## Update management (v0.6)

Read-only update status first — no update action ships until a safe
mechanism exists (see SECURITY.md):

- Settings → About shows: running version/SHA/build time, latest GHCR
  semver tag, the registry manifest digest, the remote image's git
  revision, same-version-newer-build detection, and the registry
  connectivity/auth state (hourly cache; `GHCR_TOKEN` read:packages
  server-side, never exposed).
- Updates are applied host-side with `scripts/update-dashboard.sh`: it
  recreates the container with identical env/keys/network/volumes,
  health-checks `/api/overview`, and **rolls back automatically** on any
  failure. The dashboard container never sees the Docker socket and cannot
  update itself.
- Host pulls require the one-time `scripts/login-ghcr.sh` login (PAT with
  minimum `read:packages`, stored by the Docker daemon, never in the repo
  or the UI). Until then, `docker pull` of new releases fails with
  *unauthorized* and Settings says exactly that.
- An in-app update helper (webhook → safe script, or an isolated
  purpose-built helper) is **designed but not shipped**; the missing
  preconditions (persistent host GHCR credential, security review) are
  stated in Settings instead of hidden.

## Reverse proxy deployment (v0.6, live on this host)

The documented proxy-auth pattern is now a concrete deployment:

- **Host**: `https://dashboard.familievalk.com` via Nginx Proxy Manager's
  supported custom include (`data/nginx/custom/http.conf`, no database
  edits), wildcard cert `npm-2`.
- **Authelia forward-auth** (v4.39): `auth_request` → `/api/verify` with
  `X-Original-URL`; unauthenticated browsers are 302-redirected to the
  Authelia portal (two_factor policy for this domain); the verdict identity
  is forwarded as `X-Forwarded-User` (+ groups/name/email), always
  **overwriting** client-supplied values. `AUTH_MODE=proxy` flips the app
  into enforcing mode (currently disabled — trusted-LAN mode is the
  production setting; see SECURITY.md for the trust model).
- **SSE hardening**: `proxy_buffering off`, `proxy_cache off`,
  `proxy_read_timeout 86400s`, HTTP/1.1, correct `X-Forwarded-Proto/For/Host`,
  host preserved, websocket upgrade headers where needed.
- **Access list**: LAN (192.168.1.0/24) + specific Tailscale peers, deny
  all — Cloudflare-proxied wildcard traffic (CF edge IPs) is deliberately
  refused; remote clients reach the origin via Tailscale.
- **Port 8090 isolation**: iptables restrict direct access to loopback, the
  LAN, Docker bridges (the NPM hop), Tailscale (100.64/10) and Unraid
  WireGuard (10.253/16); everything else on 8090 is dropped. Persisted via
  `/boot/config/go` (commented, one-command disable). SSH stays untouched
  as the recovery path; direct 8090 from the LAN remains the trusted-LAN
  access path and recovery fallback.

## NOC v3, kiosk & tablet (v0.6)

- **NOC wallboard** (`/noc`): fullscreen, wake lock with re-acquisition on
  visibility change, live connection state + reconnect indicator + last
  data-update timestamp, and **auto-cycle** across Overview / Docker /
  Thermal / Storage / Network panels (15s / 30s / 60s / off, persisted).
  Cycling pauses on interaction and resumes after 30s idle; an explicit
  pause button holds indefinitely. No lifecycle controls by design.
- **Dashboards in NOC**: a shared dashboard can be selected; its density
  and temperature unit apply and its name/owner/window are shown.
- **Kiosk mode** (`/noc?mode=kiosk`): larger tiles and text, a 4-tile main
  grid and a big-touch page rail (Overview / Containers / System / Storage)
  for tablets — landscape-responsive, still completely read-only.

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
| `AUDIT_DIR` | no | `/app/data` | Directory for the append-only audit log |
| `DASHBOARDS_DIR` | no | `/app/data/dashboards` | Directory for shared dashboard JSON files |
| `GHCR_TOKEN` | no | — | Server-side read:packages token for registry update checks |
| `AUTH_MODE` / `AUTH_HEADER` / `AUTH_ALLOWED_USERS` | no | disabled | Proxy-auth enforcement (see Security model) |
| `PUBLIC_BASE_URL` | no | — | External origin behind a reverse proxy (CSRF allow-list) |
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

## Security headers & CSP

The server sends Content-Security-Policy (self-only; inline allowed for
Next.js hydration and Recharts), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a
restrictive `Permissions-Policy`. All server-provided text (logs,
notifications, labels, container names) is rendered as text — no
`dangerouslySetInnerHTML` anywhere.

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

- In-app update flow behind a narrowly-scoped host-side helper (design in
  SECURITY.md) once the host holds a persistent read:packages credential
- AUTH_MODE=proxy production flip now that the Authelia forward-auth path
  is deployed (header spoofing would also need 8090 LAN isolation tightening)
- Per-container network charts if cAdvisor gets name labels (or via
  eBPF exporters)
- NOC: per-panel shared-layout composition (widget-level wallboards)
