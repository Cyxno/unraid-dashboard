# Beacon v1.6.0 — Release status & live acceptance

Datum: 2026-10-08. Release: `v1.6.0` (tag `ed7457e51fa72ec0d2b29aee4c037530af3f60d2`).
Productie: `ghcr.io/cyxno/unraid-dashboard:1.6.0` + `…-helper:1.6.0`, beide healthy.

## Provenance (Fase 34)

| Gate | Resultaat |
|---|---|
| package.json = helper = CHANGELOG latest = 1.6.0 | ✓ |
| CI tag-run groen (build → smokes → publish → re-verify) | ✓ |
| verify-published (pull + boot smokes) | ✓ beide artifacts |
| Raw OCI | version=1.6.0 · channel=release · revision=ed7457e5… (= tag-SHA) op beide |
| Tags herschreven / force-push / semver overwrite | NOOIT |
| Pre-publish smokes (lokaal) | ✓ dashboard · helper |

## Live acceptance (Fase 36) — echte productiehistorie

Actieve insights na deploy (live API-bewijs):

| Insight | Type | Evidence/window | Confidence | Wording |
|---|---|---|---|---|
| Memory creep: decypharr | trend | container.memory, 24h, quality partial | high (fit+coverage) | "increased consistently over 24h" — geen leak-claim |
| Cache pool: 39.6%, falling | capacity | storage.usagePercent, 24h | low | "Usage is falling — no capacity concern" (geen ETA bij low confidence) |
| Array: 61.6% stable | capacity | idem 7d | high | "Usage stable" |
| 30d-range | — | — | — | expliciet "unavailable — Prometheus retention shorter than 30 days" |

Geen false certainty: elke kaart draagt confidence + window; ranges i.p.v.
exacte data; "insufficient history" waar de data het niet toelaat.

## Gecontroleerd na deploy (Fase 35)

| Punt | Resultaat |
|---|---|
| v1.5.1 incident-model intact | ✓ 2 actieve echte condities, confidence full, geen regressie |
| Push subscription behouden | ✓ 1 enabled |
| Persistence intact | ✓ writable; incidents/notifications-state ongemoeid |
| Inventory intact | ✓ fresh pipeline healthy bij helper-deploy |
| Source diagnostics intact | ✓ 9 bronnen; web-push/beacon-update "never observed" terecht géén incident |
| Unraid API efficiency intact | ✓ geen nieuwe pollers; TTL-caches onveranderd |
| Insights live | ✓ echte trends uit bestaande historie |

## 2-uurs stabiliteit (Fase 37)

Gestart 23:04 UTC (24 samples × 5 min). Gemonitord: Prometheus
query_range-teller, Unraid-belasting (via sectie-TTL-gedrag + agent-API),
dashboard CPU/RAM, containerlog-errors, duplicate-insight-telling,
stale predictions en false positives. Uitslag wordt hieronder aangevuld.
