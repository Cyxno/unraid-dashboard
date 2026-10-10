# Beacon v1.7.0 — Safe Remediation & Operational Runbooks

Release notes. Full change list: `CHANGELOG.md`.

## What it does

Beacon now helps operators answer, per incident: *what can I safely check
right now, what needs confirmation, what must stay manual, what is the
expected effect, and how do I prove afterwards that it actually
recovered?*

- **Runbooks** — every incident detail page carries a deterministic,
  evidence-based runbook: explanation, prerequisites, numbered diagnostic
  checks, how recovery is proven, manual operator steps and the escalation
  condition. All text is fixed and factual. There is no AI/LLM anywhere in
  the remediation path.
- **Safe actions** — one-click, read-only diagnostics scoped to the
  incident: refresh incident evidence, re-run the persistence probe,
  re-check registry update state, re-probe Web Push delivery. Badged
  **SAFE**, cooldown-bounded, audit-logged.
- **Guarded actions** — where an existing confirmed mutation is the
  logical next step (crash-loop containment → confirmed Docker stop;
  update-failure → verified update retry), the action is offered with
  **REQUIRES CONFIRMATION**. The server re-checks every precondition
  against LIVE state just before executing; a stale UI can never start a
  mutation.
- **Operation lifecycle** — every action becomes a persisted operation:
  `pending → executing → verifying → succeeded/failed/timed-out/
  rolled-back/cancelled`. An HTTP 200 is only "accepted"; succeeded
  requires the effect to be OBSERVED in the live inventory (or the
  helper's own health verification). Timeouts re-read actual state
  instead of assuming failure of the system.
- **Conflicts, idempotency, cooldowns** — one active operation per entity
  (an update blocks stop/start and vice versa), request-id dedupe for
  double-clicks, bounded cooldowns from the central action policy.
- **Audit & support bundle** — remediation entries carry incidentId,
  operationId and traceId; support bundles include safe operation
  metadata only.

## What it deliberately does NOT do

- No autonomous destructive remediation of any kind.
- No restart action, no Docker daemon restart, no host reboot, no VM
  power control, no shell execution API.
- No privilege expansion: diagnostics need no extra capability; guarded
  actions reuse the existing action key / helper token boundaries.
- No AI/LLM in the remediation path; runbooks are static, reviewed text.
- Thermal, capacity, disk and array incidents are guidance-only, always.

## Upgrade notes

- No configuration changes required. New state file:
  `operations-state.json` under `/app/data` (bounded to 100 operations).
- v1.5/v1.6 behaviour is unchanged: incident rules, insights, push,
  update flows and permission boundaries are untouched.

## Acceptance

Full QA results are recorded in docs/RELEASE_STATUS_v1.7.0.md.



