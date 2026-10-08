# Beacon v1.5.1 — Release status & deployment verification

Datum: 2026-10-08. Patch-release: `v1.5.1` (tag `07a8e82e4b63a7dcd423e27ecb07836c7b62c9a6`).
Productie: `ghcr.io/cyxno/unraid-dashboard:1.5.1` + `…-helper:1.5.1`, beide healthy.

Pure stabilization patch vanaf main: **geen features, geen redesign, geen
architectuurwijzigingen.**

## Diff-audit v1.5.0 → v1.5.1 (feature-creep-controle)

`v1.5.0..main` vóór de bump bevatte uitsluitend: 5 fix-commits begrensd op
`src/server/incidents/*` (+ regressietests in `tests/v150-incidents.test.ts`)
en 3 docs-commits (README/ARCHITECTURE/release-notes/-status, screenshots,
screenshot-hulpscript). Geen andere src-bestanden aangeraakt. De release-commit
voegde uitsluitend versie-metadata toe (package.json, HELPER_VERSION, sw.js,
CHANGELOG, release notes).

## Fixes included (alle vijf geverifieerd aanwezig)

1. Persistence "never observed" boot false-positive (`7ee7dbb`)
2. Prometheus/source cascade suppression — scrape-targets + dependent rules
   collaboren onder het root-incident (`7ee7dbb`)
3. Thermal threshold hysteresis (hold-band warning − 5 °C) (`fee8727`)
4. Demo-mode source false-positive (`743a6d9`)
5. Persistence probe race — uniek probe-pad + lost-race-tolerantie (`13a0cc3`)

## Gates

| Gate | Resultaat |
|---|---|
| Full tests | 967/967 groen (incl. incident/persistence/push-regressies) |
| Lint | 0 fouten / 0 warnings |
| Typecheck | clean |
| Production build | OK |
| Image smokes (lokaal, pre-publish) | dashboard PASS · helper PASS |
| CI (tag v1.5.1) | groen — versiecontract, smokes, publish, re-verify |
| verify-published (pull + smoke) | beide artifacts PASS |
| Raw OCI | version=1.5.1 · channel=release · revision=07a8e82e… (exact tag-SHA) op BEIDE artifacts |
| Tags herschreven / force-push / semver overwrite | NOOIT |

## Deployment (uitsluitend officiële :1.5.1 artifacts)

`scripts/deploy-helper.sh` (candidate smoke op :8791, fresh inventory healthy)
→ `scripts/update-dashboard.sh` (snapshot → pull → recreate → health-wait;
v1.5.0 veilig geback-upt als `unraid-dashboard:previous`).

## Post-deploy verificatie (alle bevestigd)

| Punt | Resultaat |
|---|---|
| Dashboard healthy | ✓ (1.5.1, gitSha = tag-SHA) |
| Helper healthy | ✓ (helperVersion 1.5.1, reachable) |
| Inventory healthy | ✓ fresh inventory pipeline bij helper-deploy + reachable na recreate |
| Persistence healthy | ✓ dataDirWritable=true, eerste persist binnen 2 min na boot |
| Push subscription behouden | ✓ 1 subscription enabled, lastSuccess NA de deploy (20:32) |
| 0 boot false-positive incidents | ✓ geen `beacon:persistence`, geen `source:*` bij boot; alleen echte condities |
| 0 boot false-positive pushes | ✓ alleen 2 echte alarmen (cache-disk ≥45 °C, Unraid-sensoren over critical — beide hardware-echt en wisselend); persistence-push is weg |
| Thermal hysteresis correct | ✓ regressietest + hold-band live in code; package-temp onder de band → geen flap-hold meer |
| Source outages cascaderen niet | ✓ regressietest 36/7 (root-incident + attributie, geen scrape-cascade) |
| Demo mode geen false source incident | ✓ geverifieerd tegen de gepubliceerde 1.5.1-image (0 incidents, healthy) |
| Incident-state overleefde recreate | ✓ recovered-historie van v1.5.0 (17:58/19:35-episodes) intact na recreate |

## 60-minuten observatie — UITSLAG

Venster 20:34 → 21:41 UTC (**66 minuten**, 14 samples × 5 min): incidents/ids,
bronfouten, persistence, notificatiegroei, container-CPU/RAM, containerlogs
(5m-vensters). Ruwe log buiten de repo bewaard.

| Metric | Resultaat |
|---|---|
| Nieuwe / fout-positieve incidents | **0** — uitsluitend echte condities (package-thermisch, Unraid-sensoren, cache-disk rond de 45 °C-drempel, notificatie-achterstand) |
| "Flapping: host" (v1.5.0-fenomeen) | **weg** — thermal hysteresis live bevestigd: het package-incident bleef `thermal` bij drempelnadering, geen flap-hold |
| Confidence | `full` 14/14 samples |
| Persistence | `dataDirWritable=true` 14/14; geen probe-race meer |
| Source-errors | alleen `beacon-update: unavailable (never checked)` — terecht geen incident |
| Containerlog-errors | 0 in alle 14 vensters |
| Pushes in het venster | 4 echte alarmen (thermisch/sensoren/cache-disk), recovery-events volgens voorkeuren; 0 persistence/source-boot-pushes |
| Performance | dashboard-CPU 0,2–3,4% met één eenmalige piek (41% op één sample, direct terug), helper/prometheus laag; geen request-rate-explosie |

## Bekende opvolgers (geen patchdefecten)

1. **Disk-thermal heeft geen hold-band**: de cache-NVMe oscilleert rond de
   45 °C-drempel en wisselt daardoor open/dicht. Het flap-mechanisme vangt
   dit correct af (één `FLAPPING`-incident, geen push-storm), maar een
   hysterese analog aan de thermische hold-band zou het stiller maken
   (zelfde patroon als fix 3, toe te passen als toekomstige patch).
2. Eenmalige dashboard-CPU-piek (41% op één 5-min-sample, direct terug) —
   samenvallend met gelijktijdige agent-API/poll-belasting; geen aanhoudende
   belasting, geen resource-lek.
