# Beacon v1.5.1 — Stabilization Patch

Pure stabilization release on top of v1.5.0. No features, no redesign, no
architecture changes: exactly the five production findings from the v1.5.0
post-deploy verification and 2-hour stability observation, each with a
regression test. Full context: `docs/RELEASE_STATUS_v1.5.0.md`.

| # | Finding | Fix |
|---|---|---|
| 1 | "Persistence failing" opened for one cycle after every (re)start ("never observed" counted as evidence) — one false push at the v1.5.0 upgrade | Only a recorded save error or an unwritable probe opens the incident (`7ee7dbb`) |
| 2 | A real Prometheus outage would cascade into separate cAdvisor/node-exporter incidents (their scrape queries answer via Prometheus) | Both collapse under the Prometheus ROOT incident; dependent rules always emit so withholding + impact attribution work uniformly (`7ee7dbb`) |
| 3 | Package 5m average oscillating across 80 °C tripped flap-detection (safe: one incident, no storm — but wrong title/semantics) | Threshold hysteresis: open at warning, clear only below warning − 5 °C (`fee8727`) |
| 4 | A demo-mode install (purely synthetic showcase) opened a false critical "Unraid API unavailable" source incident | Demo sections count as usable with an explicit "demo mode" detail (`743a6d9`) |
| 5 | Concurrent persistence probes raced on one probe-file path; one lost unlink read briefly as "persistence degraded" in diagnostics | Unique probe path per call; lost-race unlink no longer downgrades the verdict (`13a0cc3`) |

## Upgrade notes

- Drop-in replacement for v1.5.0: no state, config, notification,
  subscription, dashboard or history changes. Incidents persisted by
  v1.5.0 remain valid.
- Dashboard and helper move together: pull `:1.5.1` of both
  (docker-compose `BEACON_TAG=1.5.1`).
