# Configuration reference

All configuration is via environment variables on the Beacon container.
Secrets are marked; they must never appear in client bundles, API responses
or logs (verified by the test suite).

## Core

| Variable | Required | Default | Description | Secret? |
| --- | --- | --- | --- | --- |
| `UNRAID_URL` | yes | — | Unraid GraphQL API base URL (e.g. `http://127.0.0.1:442`) | no |
| `UNRAID_API_KEY` | yes | — | Read-only API key for all dashboards | **secret** |
| `PORT` | no | `3000` (container: `8090`) | HTTP listen port | no |
| `TZ` | recommended | — | Timezone for day-bucketed analytics | no |
| `AUTH_MODE` | no | `proxy` | `proxy` (header + secret) or `disabled` (trusted LAN only) | no |
| `AUTH_PROXY_SECRET` | with proxy mode | — | Shared secret the reverse proxy must inject (`X-Dashboard-Auth-Token`) | **secret** |
| `AUTH_PROXY_SECRET_HEADER` | no | `X-Dashboard-Auth-Token` | Header carrying the shared secret | no |
| `AUTH_HEADER` | no | `X-Forwarded-User` | Header carrying the authenticated user name | no |
| `AUTH_ALLOWED_USERS` | no | — | Comma-separated allowlist of proxy users | no |

## Metrics

| Variable | Required | Default | Description | Secret? |
| --- | --- | --- | --- | --- |
| `PROMETHEUS_URL` | recommended | — | Prometheus base URL; enables runtime metrics, history, thermal intelligence | no |

## Update management

| Variable | Required | Default | Description | Secret? |
| --- | --- | --- | --- | --- |
| `UPDATE_HELPER_URL` | for in-app updates | — | Beacon update helper base URL | no |
| `UPDATE_HELPER_TOKEN` | with helper | — | Shared secret for the helper | **secret** |
| `GHCR_TOKEN` | for registry checks | — | GitHub token (`read:packages`) so the host can pull private images | **secret** |
| `CUSTOM_DEPLOY_CONTAINERS` | no | — | Comma-separated containers treated as custom deploys | no |
| `HIGH_RISK_CONTAINERS` | no | — | Extra name fragments classified HIGH risk | no |
| `PILOT_AUTO_CONTAINERS` | no | — | Pilot auto-update allowlist (opt-in) | no |
| `PIPELINE_OWNED_PROJECTS` | no | — | Compose projects never touched by automation | no |

## Lifecycle actions

| Variable | Required | Default | Description | Secret? |
| --- | --- | --- | --- | --- |
| `ENABLE_ACTIONS` | yes for actions | — | Master switch; actions stay disabled without the key | no |
| `UNRAID_ACTION_API_KEY` | for actions | — | Dedicated key, `DOCKER: UPDATE_ANY` only — never the read key | **secret** |
| `ACTION_COOLDOWN_MS` | no | `10000` | Per-target cooldown between actions (also applies to runbook remediation actions) | no |
| `ACTION_RATE_PER_MINUTE` | no | `12` | Global action rate limit | no |

## Safe remediation (v1.7.0)

No new configuration variables. Runbooks and safe diagnostic actions work
with an authenticated session only. Guarded runbook actions (confirmed
Docker stop on a crash loop, verified update retry) reuse the exact
lifecycle-action configuration above — without `ENABLE_ACTIONS` + the
action key (and the helper token for updates) they are refused. There is
no flag that enables autonomous remediation: Beacon does not autonomously
remediate destructive system problems, by design.

## Agent API

| Variable | Required | Default | Description | Secret? |
| --- | --- | --- | --- | --- |
| `AGENT_API_TOKEN` | for Agent API | — | Bearer token (min 32 chars) for the read-only `/api/agent/v1` | **secret** |
| `AGENT_API_TRUST_LOCAL` | no | — | Allow unauthenticated localhost access to the Agent API | no |

## Demo mode

| Variable | Required | Default | Description | Secret? |
| --- | --- | --- | --- | --- |
| — | — | — | No dedicated flag: run with an unreachable `UNRAID_URL` and a placeholder key. The UI renders synthetic data badged **Demo data**; all mutations stay disabled (no action key, no reachable Unraid API). | — |

## Data

| Variable | Required | Default | Description | Secret? |
| --- | --- | --- | --- | --- |
| volume `/app/data` | recommended | — | Dashboards, update history, automation state — persist on appdata | contains no secrets |
