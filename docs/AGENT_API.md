# Beacon Agent API

A stable, normalized, **read-only** operational API for external agents and
automation systems. Beacon is the normalization and observability layer —
the Agent API exposes state, not actions. There are no mutation endpoints
and none will be added within the `v1` namespace.

Vendor-neutral by design: no agent product, framework, or implementation is
referenced anywhere in this API.

## Auth

Dedicated credential, independent from UI sessions, the proxy secret, the
update-helper token and the action key:

```
Authorization: Bearer $AGENT_API_TOKEN
```

- `AGENT_API_TOKEN` — server-side env (min 32 chars). Never logged, never
  returned by diagnostics, never exposed to browser JS.
- Constant-time comparison.
- Optional: `AGENT_API_TRUST_LOCAL=true` allows passwordless read access
  from loopback/LAN sources (explicit opt-in; default is token-required).

### Token rotation

Set the new token in one consumer at a time — the API accepts only one
token per deployment. To avoid a gap: deploy consumers with the new token,
then restart Beacon with the new `AGENT_API_TOKEN`. A future release may
accept a secondary `AGENT_API_TOKEN_NEXT` during transitions.

## Endpoints

All endpoints are GET, return `apiVersion`/`beaconVersion`/`generatedAt`
envelopes, and expose explicit freshness (`sampledAt`/`stale`/`ageSeconds`)
where data comes from polls.

| Endpoint | Purpose |
|---|---|
| `/api/agent/v1/capabilities` | Supported API features (`mutations: false`) |
| `/api/agent/v1/summary` | Compact operational overview |
| `/api/agent/v1/docker` | Per-container normalized state |
| `/api/agent/v1/issues` | Active/resolved conditions (see below) |
| `/api/agent/v1/projects` | Compose project registry |
| `/api/agent/v1/storage` | Array, pools, disks |
| `/api/agent/v1/system` | CPU/RAM/load/temps/uptime/network |
| `/api/agent/v1/operations` | Update/automation/backup state |
| `/api/agent/v1/events` | Recent container transitions (`since`, `limit`) |
| `/api/agent/v1/stream` | SSE stream (typed events, hello snapshot) |
| `/api/agent/v1/openapi.json` | Machine-readable API description |

## Issues

Issue IDs are deterministic (`category:target:condition`), so the same
ongoing condition keeps its identity across polls. Lifecycle:
`active` → `resolved` (retained 10 minutes with `resolvedAt`).

Example:

```json
{
  "id": "docker:example:unhealthy",
  "severity": "critical",
  "category": "docker",
  "status": "active",
  "condition": "container_unhealthy",
  "summary": "Container example reports unhealthy",
  "target": { "type": "container", "id": "abc", "name": "example" },
  "firstSeenAt": "...",
  "lastSeenAt": "...",
  "observedForSeconds": 420,
  "metrics": {},
  "context": {},
  "suggestedChecks": ["Inspect container logs"]
}
```

`suggestedChecks` are informational strings only — never executable
instructions.

## SSE stream

`GET /api/agent/v1/stream` — `text/event-stream`.

- `hello` on connect: apiVersion, beaconVersion, timestamp, identity, health.
- Typed events: `docker.transition`, `system.health`. Compact payloads.
- `id:` lines + `Last-Event-ID` header support (bounded 200-event replay).

## Errors

Structured, stable codes:

```json
{ "error": { "code": "UNAUTHORIZED", "message": "Agent API token invalid or missing." } }
```

Codes: `UNAUTHORIZED`, `FORBIDDEN` (disabled), `RATE_LIMITED`,
`INVALID_QUERY`, `NOT_FOUND`, `INTERNAL`.

HTTP semantics: 200 success · 400 invalid query · 401 auth · 404 unknown
resource · 429 rate limited · 503 only when an endpoint genuinely cannot
provide useful data.

## Rate limits

Per endpoint, per source, fixed 60s windows: summary 120/min, data
endpoints 60/min, capabilities 30/min, stream connect 10/min. SSE is the
preferred transport for frequent consumers.

## Examples

```sh
curl -s -H "Authorization: Bearer $AGENT_API_TOKEN" \
  http://beacon.local:8090/api/agent/v1/summary

curl -s -H "Authorization: Bearer $AGENT_API_TOKEN" \
  http://beacon.local:8090/api/agent/v1/issues?status=active

curl -s -N -H "Authorization: Bearer $AGENT_API_TOKEN" \
  http://beacon.local:8090/api/agent/v1/stream
```

## Stability

Once `v1` ships, schemas are stable: additive fields allowed; breaking
changes require a new namespace (`/api/agent/v2/...`) or an explicit
migration strategy.
