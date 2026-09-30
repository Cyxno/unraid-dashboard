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

## 1. Create the Unraid API key

Unraid → **Settings → Management Access → API Keys** → create a key for Beacon.

Minimum roles for the dashboard: read-only access to Docker, info, array,
disk, network and notifications. Beacon never needs write access for its
dashboards.

Keep this key secret — it is stored server-side by the Beacon container and
never sent to the browser.

## 2. Install the container

Unraid → Docker → Add Container using the Beacon template, or equivalent
`docker run`:

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

The update helper is a separate container with the Docker socket. Install it
per its own README, then set on Beacon:

- `UPDATE_HELPER_URL` (e.g. `http://127.0.0.1:8790`)
- `UPDATE_HELPER_TOKEN` (shared secret, root-only file recommended)

With the helper configured, Settings → Updates offers in-app updates with
digest verification and automatic rollback. Without it, updates are performed
host-side with `scripts/update-dashboard.sh`.

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
