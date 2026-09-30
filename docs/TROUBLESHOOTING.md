# Troubleshooting

## Dashboard cannot reach Unraid

**Symptom:** banners report "Degraded"/"Offline", identity shows the default
name, demo-data badge appears.

- Check `UNRAID_URL` (typically `http://127.0.0.1:442`) and that the API is
  enabled on the host.
- Key problems → Settings → Diagnostics shows "Unraid API: unreachable" and
  the last successful fetch.
- If the key was rotated on Unraid, update `UNRAID_API_KEY` and recreate the
  container.

## Prometheus unavailable

**Symptom:** "Runtime metrics unavailable — Prometheus not reachable", no
history chart, thermal cards show the reason.

- Check `PROMETHEUS_URL` and that Prometheus is reachable from the Beacon
  container (`--network host` helps on Unraid).
- Beacon degrades gracefully: Unraid state pages remain live.

## Actions disabled / failing

**Symptom:** `/api/actions/status` → `enabled: false`, no Start/Stop buttons.

- `ENABLE_ACTIONS` must be `true` **and** `UNRAID_ACTION_API_KEY` must be set.
- The action key needs **only** `DOCKER: UPDATE_ANY`. If it was rotated on
  Unraid, update the env and recreate the container — capability surfaces
  update automatically on the next poll.
- "accepted but not verified" toasts mean the POST succeeded but the expected
  container state was not observed in time — check the container; the action
  itself may still have completed (slow stop).

## Update check unavailable / GHCR auth

**Symptom:** "release check: unknown", "GHCR login required".

- The host needs `read:packages` once: `sh scripts/login-ghcr.sh`.
- Without it, Beacon reports releases from locally present images
  ("source: local images") and strict remote updates are refused.

## "Registry verified" missing / digest mismatch

- Open Operations → Release chain. `digestMatch: false` means the running
  image differs from the registry — re-run the update. The helper logs the
  exact digests. Never bypass the verification.

## Agent API disabled / 403

- Set `AGENT_API_TOKEN` (min 32 chars) to enable `/api/agent/v1`.
- 403 with a token means the token is wrong — it is constant-time compared
  and never logged.

## PWA icon wrong / generic letter on iOS

- The served assets are correct; iOS caches home-screen icons. Remove the
  shortcut, force-quit Safari, reopen, re-add. Full procedure and the
  reverse-proxy icon caveat: [PWA.md](PWA.md).

## Service worker stuck on old assets

- The app prompts for updates; a refresh activates the waiting worker. If a
  page is stuck: hard-refresh once. The SW version tracks the package version
  (visible in Settings → About).

## Wrong proxy secret / logged out

- 401 on everything through the reverse proxy: the proxy must send
  `X-Dashboard-Auth-Token: <AUTH_PROXY_SECRET>` exactly; check the header
  name and value on both sides.

## Stale metrics

- Metrics carry their own status (`live`/`stale`/`unavailable`) with a reason.
  Stale means Prometheus responded but samples lagged — check Prometheus
  targets/scrape health.
