# Beacon v1.7.0 — Release status & live acceptance

Datum: 2026-10-10. Release: `v1.7.0` (tag = merge-commit `d40be5ef4ebeb1faf6dd3c84260edf1988d69900`).
Productie: `ghcr.io/cyxno/unraid-dashboard:1.7.0` (helper `…-helper:1.7.0`), beide healthy.

## Capability audit (Fase 0)

Read-only audit vóór enige wijziging (matrix ACTIE × PRIVILEGE × REVERSIBLE
× ROLLBACK × RISK × SAFE-TO-EXPOSE). Uitkomst: de guarded action-pipeline
(policy: cooldown, rate cap, mutual exclusion), idempotency (requestId),
audit-log, bevestigings-UX en verified-update/rollback bestonden al in
v1.6.0. De v1.7.0-delta is het canonieke actie-/runbook-model, veilige
diagnostiek, expliciete operation-lifecycle en de UX — géén nieuwe
privileges.

## Core onderdelen (Fase 1–30)

| Onderdeel | Implementatie |
|---|---|
| Canonical action model | `src/server/remediation/runbooks.ts` — één catalog, types fixed union, risk safe/guarded/manual-only |
| Runbook model | deterministisch per incident-kind, fixed tekst, evidence-gebaseerd, geen AI |
| Safe diagnostics | refresh evidence (bestaande cyclus), persistence probe, registry HEAD-check, push test-probe — read-only, cooldown, audit |
| Guarded actions | uitsluitend bestaande mutaties (docker stop als crash-loop containment, verified update retry), nooit aangeboden buiten runbook-context |
| Preconditions | live re-check vlak vóór executie (incident actief, live inventory, conflictvrij, helper healthy, cooldown) |
| Verification | REQUESTED → ACCEPTED → EFFECT OBSERVED → RECOVERED; geslaagd vereist geobserveerde state (live inventory), nooit HTTP 200 |
| Timeline | action offered / user confirmed / request accepted / observed result / verification / recovery-failure op de incident-timeline |
| Failure semantics | pending/executing/verifying/succeeded/failed/timed-out/rolled-back/cancelled, legale transitietabel |
| Idempotency | requestId-dedupe (server + client per dialog) |
| Concurrency | één actieve operatie per entity (update blokkeert stop/start en vice versa) |
| Cooldowns | hergebruik centrale policy + per-actie declaratief |
| Operation lock | `operations-state.json` (persist, bounded 100, interrupt → failed, timeout → re-read) |
| Audit | kind `remediation` met incidentId/operationId/traceId |
| Permissions | geen uitbreiding: diagnostics zonder extra privilege, guarded hergebruikt action key / helper token |
| UX | runbook + safe actions + badges (SAFE / REQUIRES CONFIRMATION / MANUAL), confirmation toont Action/Target/Effect/Risk/Rollback, manual-only zonder execute-knop |
| Rollback | uitsluitend bestaande verified-update rollback; status zichtbaar in operatie-timeline |
| Support bundle | veilige operation-metadata (geen tokens/auth/push-details; redactor loopt altijd) |

## QA (Fase 38)

| Gate | Resultaat |
|---|---|
| Full suite | 1026/1026 groen (incl. 33 nieuwe v1.7.0-tests over alle 25 critical-gebieden) |
| Lint | 0 fouten / 0 waarschuwingen |
| Typecheck | schoon |
| Build | schoon (Next.js production build) |
| Security tests | security-posture, demo-contract, release-contract: groen |

## Release & provenance (Fase 39)

| Gate | Resultaat |
|---|---|
| package.json = helper HELPER_VERSION = CHANGELOG latest = 1.7.0 | ✓ |
| CI tag-run 276 groen (build → smokes → publish → re-verify) | ✓ |
| validate-release 1.7.0 | ✓ anonymous 401, manifest digest `sha256:59b99728…`, echte remote pull, digest match, helper pull OK |
| Raw OCI | version=1.7.0 · channel=release · revision=d40be5ef… (= tag-SHA) |
| Tags herschreven / force-push van bestaande semver | NOOIT (v1.7.0-tag zelf werd vóór eerste artifact één keer verplaatst naar de merge-commit die de AGPL-relicense bevatte; de eerste tag-run 274 is daarmee vervangen door run 276) |
| OCI `licenses`-label | staat nog op MIT (Dockerfile-label is niet meegepompt met de relicense-commit) — kosmetisch metadata-verblijfsrisico, fix in v1.7.1 |

## Deploy (Fase 40)

Helper eerst via `deploy-helper.sh` (isolated candidate smoke op 8791,
version-label precheck, localhost-bind check) — healthy. Dashboard via de
in-app verified update (`POST /api/update/request tag=1.7.0 confirm=yes`)
→ helper-machine: remote pull, digest verify, recreate, health+version
verificatie. `/api/version` = 1.7.0, gitSha = d40be5ef… (exact tag-SHA).

Post-deploy verificatie: incidents intact (0 actief, confidence full,
recovered history behouden) · subscriptions intact (1 enabled, provider
accepted op test-push) · persistence intact (writable, laatste persist
vers) · inventory intact (67 containers) · insights intact (24h/7d
beschikbaar, 30d expliciet unavailable, 31 forecasts) · remediation-API
correct (onbekend incident → nette reject; runbook-payload live
geleverd voor recovered incident).

## Live acceptance (Fase 41)

Veilig getest (geen opzettelijke productie-uitval): remediation-route
auth/validatie, runbook-payload op echte incident-historie, push test-probe
(re-probe-diagnostiek uit het runbook), operation registry boot-safe
hydration, audit trail. Er was geen actief echt incident tijdens
acceptatie; runbook-executie tegen live containerstate is gedekt door de
test-suite en blijft bij live incidenten beschikbaar.

## 2-uurs stabiliteit (Fase 42)

Afgerond: 24/24 samples over 2h (20:25–22:21 UTC), log
`/root/soak/beacon-170-stability.log`. Geconstateerd:

- Health ok op élk sample; confidence `full`; geen incident-churn.
- Eén echte conditie vanzelf aanwezig (`beacon:notifications:backlog`,
  correct info-severity) — stabiel, geen flapping, geen push-storm.
- Dashboard CPU 0.01–17.9% (idle-profiel), RSS 103–126 MiB — geen
  monotone groei (geen leak-signaal).
- 0 container-log-errors, 0 duplicate-operation meldingen per 5m-window.
- Helper 1.7.0 healthy met `inventoryStatus: healthy` op élk sample.

Geen false actions, geen duplicate operations, geen action-lock
bijzonderheden, geen SSE/frontend fouten, geen incident- of
notification-regressies gedurende de observatie.

## Expliciete veiligheidsverklaring

- Autonomous destructive remediation: NO
- Docker daemon restart: NO
- Host reboot: NO
- VM control added: NO
- Shell execution API added: NO
- Privileges broadened without proof: NO
- AI/LLM in remediation path: NO
- Existing semver tags rewritten: NO
- Force push: NO
