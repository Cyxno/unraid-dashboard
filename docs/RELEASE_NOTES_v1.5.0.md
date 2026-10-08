# Beacon v1.5.0 — Incident Intelligence & Self-Diagnostics

Release notes. For the full change list see `CHANGELOG.md`; for the
pre-release ground truth see `docs/baselines/v1.5.0-baseline.md`.

## Why

Before v1.5.0, Beacon answered "is something wrong?" through four parallel
engines with different vocabularies (a heuristic health block, a container
classifier, notification sources and the agent issue registry) and about a
dozen ad-hoc staleness checks. A source outage surfaced as scattered
degraded sections — or worse, as stale data that still read as healthy.

v1.5.0 makes Beacon answer, for every warning/critical:

1. What is wrong? 2. Which evidence proves it? 3. Which source observed it?
4. How old is that data? 5. Is the source itself healthy? 6. Is this one
incident or the consequence of a bigger one? 7. How long has it existed?
8. Is it flapping? 9. Has it recovered? 10. What is a safe next check?

## The model

```
signal sources ──► source-health registry ──► rules (deterministic)
      │                                            │
      │                                    RuleCandidates
      │                                            ▼
      └──────────── observation ─────────► incident ENGINE
                                                   │
                              lifecycle · debounce · flapping ·
                              cascade suppression · escalation
                                                   ▼
                        incidents-state.json (/app/data, bounded)
                                                   ▼
             Incident Center UI · Overview banner · Web Push · agent API
```

- **Source health** (`src/server/incidents/source-health.ts`): every fetch
  path reports attempts; status derives as
  `healthy | degraded | stale | unavailable`. A source whose last
  successful observation is past its freshness band reads `stale` even
  with no recorded failure — silence is never healthy.
- **Freshness** (`freshness.ts`): the single classifier, banded per
  source interval (`fresh ≤ max(2×interval, 10s)`,
  `aging ≤ max(6×interval, 60s)`, else `stale`).
- **Evidence** (`evidence.ts`): `direct` (the source states the fact),
  `derived` (a rule computed it), `correlated` (observed together — the
  UI says "correlated with", never "caused by") or `unknown`.
- **Incidents** (`engine.ts`): fingerprint-identified lifecycle
  OPEN → ACTIVE → RECOVERED with truthful duration (debounce anchors
  become `firstSeenAt`), single recovery per episode, flap-hold (one
  FLAPPING incident, recovery only after a 10m stable streak),
  crash-loop on proven patterns only, warning→critical escalation after
  15 minutes sustained unhealthy.
- **Cascade suppression**: a source outage yields one root incident with
  an impact list; dependent rules are withheld and their impact is
  attributed to the root. Recovery is withheld while a governing source
  cannot decide — no false recoveries through outages.
- **Persistence** (`store.ts`): `/app/data/incidents-state.json`, atomic
  writes, boot-safe hydration, recovered history bounded to 50 episodes
  / 24h. Incidents survive container recreates.

## Severity policy (v1.4.x audit result)

| Condition | v1.4.x | v1.5.0 |
|---|---|---|
| Array not started / disk RED / parity failed | critical | critical (unchanged) |
| Container unhealthy | critical | warning → critical after 15m sustained |
| Sustained thermal (package 5m / Unraid sensors) | attention–critical | warning, with correlated-workload evidence |
| Crash loop | (implicit) | warning |
| Update FAILED | (implicit) | warning |
| Update AVAILABLE | info, not health | unchanged |
| Stopped containers | neutral | neutral (unchanged) |
| Unread Unraid notification backlog | critical | info (review prompt; live conditions get their own incidents) |
| Core source unavailable (Unraid API, Prometheus, persistence) | attention/partial | critical root incident with impact |
| Helper / cAdvisor / node-exporter / web-push degraded | partial | warning |

## What changed for users

- New **Incident Center** (`/incidents`): ACTIVE + RECENTLY RECOVERED,
  one row per incident (severity, entity, duration, reason, source,
  freshness), tap for the full evidence/timeline/impact detail.
- **Overview** shows a single summary banner ("N critical · M warning
  incident(s) · top reason") linking to the Center — the same text no
  longer appears three times.
- **Settings → Source diagnostics**: per-source status table, the
  observability-confidence banner (`full | degraded | blind`) and the
  persistence self-check, plus **Generate diagnostics** — a sanitized
  support bundle safe to attach to an issue (redaction-tested).
- **Push notifications** deep-link to the incident detail and dedupe on
  the incident fingerprint; delivery shows only proven facts
  ("push provider accepted" / "delivered in-app").

## Upgrade notes (v1.4.3 → v1.5.0)

- Fully additive: no config/notification/subscription/dashboard/history
  state is touched. New on-disk state: `incidents-state.json`.
- First engine cycle after the upgrade ingests current conditions
  SILENTLY (baseline guard) — no notification storm.
- Fingerprints that existed in v1.4.x
  (`docker:container:<name>:unhealthy`, `storage:disk:<name>:<level>`,
  `services:helper:unreachable` → now `source:helper:degraded`) keep
  deduping; the helper fingerprint change may pair one "resolved" with
  one "new" notification if the helper happens to be down mid-upgrade.
- The dashboard image and helper image move together: pull
  `:1.5.0` of both (docker-compose `BEACON_TAG=1.5.0`).

## Performance

The engine runs on the existing overview cadence and consumes only
cached surfaces (section TTL caches, in-memory transitions, 30s-cached
helper status, read-only inventory LKG peek, 60s-cached persistence
probe). No new standing pollers, no per-card queries, no N+1 inspects.
`tests/v150-incidents.test.ts` pins this structurally (case 27).
