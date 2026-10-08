# Beacon v1.5.0 — Release status & production acceptance

Datum: 2026-10-08. Release: `v1.5.0` (tag `5b789cea5241400f5beaa67e2db13382ddcc67f2`).
Productie: `ghcr.io/cyxno/unraid-dashboard:1.5.0` + `…-helper:1.5.0`, beide healthy.

## Release-provenance (Fase 36/37)

| Gate | Resultaat |
|---|---|
| package.json = 1.5.0, HELPER_VERSION = 1.5.0, CHANGELOG latest = v1.5.0 | ✓ (contract-test) |
| Versietag == package.json (CI `ver`-gate) | ✓ (run #258 groen) |
| Pre-publish image smokes (CI + lokaal) | ✓ dashboard (health/version/PWA/SSE), helper (mock-docker fresh inventory healthy) |
| Gepubliceerde artifacts opnieuw geverifieerd (pull + zelfde smokes) | ✓ `scripts/verify-published.sh` beide images |
| Semver-tags herschreven / force-push | NOOIT (immutable-semver policy) |
| Deploy-medium | `scripts/deploy-helper.sh` (candidate smoke op :8791) + `scripts/update-dashboard.sh` (snapshot → pull → recreate → health-wait → rollback-zekerheid) |

## Productie-acceptatie (Fase 40) — echte condities, geen verstoringen

Bij oplevering actieve incidents (live API-bewijs, `/api/incidents`):

| Incident | Severity | Bron | Evidence (type/freshness) | Duur/verloop |
|---|---|---|---|---|
| `storage:disk:cache:warning` | warning | unraid-api | `disk.temperatureC = 58 (threshold 45)` (derived, fresh) | open sinds 17:58, blijvend |
| `host:thermal:package` | warning | prometheus | `81°C 5m-gemiddeld` (derived) + `correlated with: … VM CPU NOT attributable` (correlated) | geopend 17:58 → flap-hold bij drempelgrens → gerecovered 18:27 na stabiele periode |
| `host:thermal:unraid-sensors` | warning | unraid-api | `criticalCount=2` (direct, fresh) | open 17:58 → gerecovered 18:13 |
| `beacon:notifications:backlog` | info | unraid-api | `alert=22` (direct) | open, review-prompt |

Bewezen gedrag in productie:

- **stopped ≠ incident**: 8 exited containers, 0 incidents (regressietest 1 + live).
- **update ≠ health**: "14 container updates available" staat in de notificatie-activeset maar NIET in incidents; health negeert het.
- **cascade-onderdrukking**: Prometheus/Unraid-API-outages zijn via fixtures getest (één root-incident + impact-attributie); in productie is de bronset healthy gebleven.
- **upgrade zonder storm**: baseline-werking bevestigd — de v1.4.x-condities (cache-disk, updates) dedupeden; 3 pushes na upgrade, waarvan 2 echte alarmen (thermisch) en 1 fout-positieve (zie Risico's).
- **recovery**: thermal- en sensor-incidents herstelden exact één keer, met correcte duration en geen push-storm (resolved-events volgens voorkeuren).

## Post-deploy bevindingen → gefixt op main (7ee7dbb, fee8727, 743a6d9)

1. **Persistence "never observed" (boot-cyclus)** opende één cyclus een fout-positief "Persistence failing" (1 push bij de upgrade). Fix: alleen bewezen faalbewijs (save-error / niet-schrijfbare probe) opent het incident. + regressietest.
2. **Real-outage cascade-vorm**: een echte Prometheus-storing zou via diens scrape-queries óók cAdvisor/node-exporter-incidents openen. Fix: die collaboren onder het Prometheus-root-incident; afhankelijke regels worden gehandhaafd en geattribueerd. + regressietest.
3. **Thermische drempel-hysterese**: de 5m-gemiddelde package-temperatuur pendelde over 80 °C (81 → 79.6 → 81) en tripte flap-detectie (veilig: één incident, geen storm, maar onjuiste titel). Fix: hold-band tot warning − 5 °C, conform de v0.6-episode-logica. + regressietest.
4. **Demo-mode**: een puur synthetische showcase opende een fout "Unraid API unavailable"-incident. Fix: demo-secties tellen als bruikbaar met expliciete detail. + handmatig geverifieerd.

Alle fixes: 967/967 tests groen, lint 0/0, typecheck clean. De v1.5.0-tag is NIET herschreven (immutable-semver policy); de fixes liggen klaar op main voor een 1.5.1-patch-release.

## 2-uurs stabiliteit (Fase 41)

Wordt uitgevoerd op de productie-tag 1.5.0 (24 samples × 5 min):
incidents-counts/ids, diagnostics-bronfouten, persistence, notificatiegroei,
container CPU/RAM (dashboard/helper/prometheus) en containerlog-errors.
Resultaat wordt na afloop in dit document aangevuld.

## Bekende risico's (bij oplevering)

1. Tag 1.5.0 bevat de vier post-deploy-fixes nog niet (ze liggen op main); de persistence-bootcyclus en de thermische flap-titel zijn er dus nog in — beperkt tot respectievelijk één cyclus na een (re)start en een cosmetische titel tijdens drempelfladderen; geen push-storm, geen cascade.
2. De agent-API (`/api/agent/v1/issues`) behoudt zijn eigen issue-engine (bewust buiten scope); de Incident Center/API is de canonieke bron voor de UI en notificaties.
