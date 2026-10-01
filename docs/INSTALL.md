# Installing Beacon

## Prerequisites

- **Unraid 7.x** with the GraphQL API enabled (default on 7.x; the API listens
  on `127.0.0.1:443`/`:442` locally).
- **Docker** (Unraid's built-in Docker manager is fine).
- An **Unraid API key** — read-only is enough for every dashboard feature.
- **Prometheus** (optional but recommended): runtime metrics, history charts,
  thermal intelligence and per-container stats all come from Prometheus.
  Without it Beacon stays fully functional with Unraid state only, and shows
  which widgets are degraded and why.
- **Beacon update helper** (optional): required for in-app container updates.
  It is a separate, tiny container and the **only** component with access to
  the Docker socket.

## Choose an install path

Beacon is one product shipped as two containers: the **dashboard** (the web
app) and the optional **update helper** (the only component with Docker
access, used for verified in-app updates and automatic rollback).

| Path | Gets you | Best for |
| --- | --- | --- |
| **A. Compose bundle** (recommended) | dashboard + helper as one stack | any Docker host, Unraid 7.2+ |
| **B. Unraid Compose stack** | same bundle via the Docker tab UI | Unraid 7.2+ without git |
| **C. Community Applications** | dashboard as a normal Unraid app | Apps-tab users; updates via Unraid |
| **D. Plain `docker run`** | dashboard only | minimal/manual setups |

## Path A — compose bundle (recommended)

```sh
git clone https://github.com/Cyxno/unraid-dashboard.git
cd unraid-dashboard
cp .env.example .env
# edit .env: set UNRAID_API_KEY (read-only is enough) and, for in-app
# updates, UPDATE_HELPER_TOKEN (generate once with: openssl rand -hex 32)
docker compose up -d
```

The bundle starts both containers as one product:

- `unraid-dashboard` — the web app on `http://<server>:8090` (host
  networking, so it reaches the Unraid API and Prometheus on localhost).
- `unraid-dashboard-helper` — localhost-only update helper. It is wired to
  the dashboard automatically; you only provide the shared
  `UPDATE_HELPER_TOKEN` in `.env` (never committed, never logged). Without a
  valid token the helper runs fail-closed and Settings → Updates says so.
- Both containers use `BEACON_TAG` (default `latest`) so the stack upgrades
  in lockstep; pin a release in `.env` (e.g. `BEACON_TAG=1.1.1`) for
  stability. Images are amd64.
- Persistent state lives under `APPDATA_PATH`
  (default `/mnt/user/appdata/unraid-dashboard`). The dashboard container
  runs as uid 1001 — `chown 1001:1001` the directory if it cannot write.

**Upgrading the stack:** `docker compose pull && docker compose up -d`, or
pin `BEACON_TAG` to a release. In-app updates (via the helper) also work on
a compose install: they recreate the container with identical configuration
and roll back automatically on failure. To stop only the dashboard while
keeping the helper: `docker compose stop unraid-dashboard` — and the other
way around; each container is useful on its own.

## Path B — Unraid 7.2+ Compose stack (no git)

Unraid 7.2 and later manage compose stacks natively:

1. **Docker → Compose → Add New Stack**, name it `beacon`.
2. Paste [`docker-compose.yml`](../docker-compose.yml) as the compose file.
3. Create the `.env` next to the stack with `UNRAID_API_KEY` (and
   `UPDATE_HELPER_TOKEN` for in-app updates).
4. Start the stack and open `http://<server>:8090`.

## Path C — Community Applications

The Apps tab installs one container per template, so Beacon ships two
canonical templates in [`templates/`](../templates/README.md):

- Install **unraid-dashboard** for the dashboard (image updates then flow
  through Unraid's own Apps-tab mechanism).
- Optionally install **unraid-dashboard-helper** for verified in-app
  updates. It serves `127.0.0.1:8790` only by design, so it pairs with the
  compose bundle or a host-network dashboard — see the template overview.
- Create the read-only Unraid API key as described below and paste it into
  the masked **Unraid API key** field.

## 1. Create the Unraid API key

Unraid → **Settings → Management Access → API Keys** → create a key for Beacon.

Minimum roles for the dashboard: read-only access to Docker, info, array,
disk, network and notifications. Beacon never needs write access for its
dashboards.

Keep this key secret — it is stored server-side by the Beacon container and
never sent to the browser.

## 2. Install the container (plain `docker run`)

Path D — equivalent to the compose bundle for the dashboard alone:

```sh
docker run -d --name unraid-dashboard \
  --network host \
  --restart unless-stopped \
  -e UNRAID_URL="http://127.0.0.1:442" \
  -e UNRAID_API_KEY="<read-only key>" \
  -e PORT=8090 \
  -v /mnt/user/appdata/unraid-dashboard:/app/data \
  ghcr.io/cyxno/unraid-dashboard:latest
```

- `--network host` lets the container reach the Unraid API and Prometheus on
  localhost; the web UI listens on `PORT` (default 8090).
- `/app/data` stores dashboards, update history and automation state — put it
  on appdata so it survives container replacement.
- Unraid → Docker → Add Container with the
  [`templates/unraid-dashboard.xml`](../templates/unraid-dashboard.xml)
  template produces the same container (bridge network; point `UNRAID_URL`
  at the tower's IP in that case).

Open `http://<server>:8090`. Done — everything else is optional.

## 3. Optional: Prometheus

Set `PROMETHEUS_URL` (e.g. `http://127.0.0.1:9090`). This enables runtime
container metrics, the resource history chart, thermal intelligence and
top-consumer attribution. Beacon only reads (instant + range queries); it
never writes to Prometheus.

## 4. Optional: lifecycle actions (Start/Stop)

Start/Stop is disabled until you explicitly opt in:

1. Create a **second** API key used only for actions, with
   `DOCKER: UPDATE_ANY` — nothing else.
2. Configure it on the Beacon container as `UNRAID_ACTION_API_KEY`
   (masked field in the template) and recreate the container.
3. `/api/actions/status` now reports `enabled: true, docker: ["start","stop"]`.

Every action is confirmed in the UI, cooldown- and rate-limited, and
audit-logged. Restart is not offered — the verified Unraid API has no restart
mutation.

## 5. Optional: in-app updates (helper)

With the compose bundle (paths A/B) the helper is already part of the stack —
you only set `UPDATE_HELPER_TOKEN` in `.env`. For standalone installs
(paths C/D), deploy it once:

```sh
UPDATE_HELPER_TOKEN=$(openssl rand -hex 32) scripts/deploy-helper.sh
```

then set on Beacon:

- `UPDATE_HELPER_URL` (e.g. `http://127.0.0.1:8790`)
- `UPDATE_HELPER_TOKEN` (the same secret; stored server-side only)

The helper binds `127.0.0.1:8790` only, is the **only** component with
Docker-socket access, and refuses every request (fail-closed) unless the
token is set. It updates only the `unraid-dashboard` container, semver tags
only. With the helper configured, Settings → Updates offers in-app updates
with digest verification and automatic rollback. Without it, updates are
performed host-side with `scripts/update-dashboard.sh`.

## 6. Optional: Agent API

Set `AGENT_API_TOKEN` (min 32 chars) to enable the read-only machine API under
`/api/agent/v1`. See [AGENT_API.md](AGENT_API.md).

## 7. Reverse proxy / auth

Beacon supports two access models:

- **Trusted LAN**: direct access to `:8090` from the local network. Requests
  are accepted as a fixed `trusted-local` identity; identity headers from the
  client are ignored.
- **Reverse proxy** (recommended for anything exposed): set
  `AUTH_MODE=proxy`, `AUTH_PROXY_SECRET` and protect the app with e.g.
  Authelia/NPM. The proxy injects `X-Dashboard-Auth-Token: <secret>` plus the
  user header (`X-Forwarded-User`); a wrong secret is rejected with 401.

Exempt static PWA assets (`/icons/*`, `/manifest.webmanifest`,
`/apple-touch-icon.png`) from the auth redirect if you install the PWA
through the proxy — see [PWA.md](PWA.md).

## 8. PWA

Open Beacon in a mobile browser → *Add to Home Screen*. Icons, offline shell
and standalone behavior are automatic; iOS specifics (icon cache, remove/re-add
after icon changes) are documented in [PWA.md](PWA.md).

## Demo mode

To explore Beacon without an Unraid server, run it with placeholder
credentials — the UI renders a synthetic dataset badged **Demo data**, and all
mutation paths stay disabled:

```sh
docker run -d -p 3200:8090 \
  -e UNRAID_URL="http://127.0.0.1:1" \
  -e UNRAID_API_KEY="00000000000000000000000000000000" \
  ghcr.io/cyxno/unraid-dashboard:latest
```

## Updating

See [UPDATING.md](UPDATING.md) — in-app (helper) or host-side script; both
verify the registry digest and roll back on failure.
