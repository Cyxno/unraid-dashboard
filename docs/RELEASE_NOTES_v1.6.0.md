# Beacon v1.6.0 — Operational Intelligence & Capacity Forecasting

Release notes. Full change list: `CHANGELOG.md`; data-ground-truth:
`docs/baselines/v1.6.0-data-availability.md`.

## What it does

Beacon now answers the slow questions — deterministic statistics over
history it ALREADY has, no ML/AI, no cloud, no new monitoring stack:

- **Capacity Forecast** — storage usage trend per pool/disk (24h/7d),
  growth per day/week, and threshold projections at 80/90/95%.
  Forecasts are honest by construction: medium confidence renders a
  range ("would reach 90% in ~2–4 weeks"), low confidence renders
  direction only, insufficient history renders "insufficient history".
  On installs where Prometheus retention is shorter than 30 days, the
  30d range is explicitly marked unavailable.
- **Memory creep** — "Memory usage has increased consistently over 24h"
  per container, with start/current/delta/slope and confidence. A single
  spike is never a creep; "memory high" is never a leak claim.
- **CPU baseline drift** — current rolling average vs the container's own
  7d baseline; suppressed when host-wide workload explains the rise.
- **Thermal baseline** — idle/p50/p95, daily-max trend and drift vs the
  like-for-like prior week ("CPU package temperature baseline +8 °C vs
  prior week" only when windows are comparable).
- **Incident recurrence** — "6 occurrences / 7d, total 3h 42m" per
  fingerprint; incident retention is now 30d (bounded at 500 episodes).
- **Restart recurrence** — restart patterns per container with cluster
  detection; planned restarts (update runs, pipeline-owned projects) are
  correlated instead of flagged.
- **Update impact** — "After update: memory +18%, no restart increase" —
  correlation-only wording, never "caused by".
- **Source performance** — p50/p95 latency per source.

## What it deliberately does NOT do

- No generic 0–100 health score — evidence-based incidents remain the
  alarm model; insights are supplementary and visually separated.
- No automatic remediation — insights carry at most a safe suggestion
  ("Review largest cache consumers.").
- No push by default — the new "insights" notification category is OFF;
  only capacity-critical-soon and extreme persistent degradation are
  eligible when the operator opts in.
- No raw sample storage — Prometheus remains the history source; Beacon
  persists only bounded insight identity (200 fingerprints).

## Performance

Range queries are TTL-cached per window (24h → 5 min, 7d → 15 min,
30d → 1 h) and server-side aggregated; the insight cycle is
single-flight with a 2-minute minimum interval; the Overview strip polls
at most every 2 minutes. No new standing pollers.

## Upgrade notes

- Drop-in on v1.5.1: additive state only (`insights-state.json`).
- Incident history retention widens from 24h/50 to 30d/500 — existing
  history is preserved, growth is bounded by pruning on save.
- The "insights" notification category appears in Settings →
  Notifications, default OFF.
