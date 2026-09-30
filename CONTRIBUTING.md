# Contributing to Beacon

Thanks for considering a contribution. Beacon is a self-hosted Unraid
dashboard with a strict security model — contributions must preserve it.

## Local setup

```sh
git clone git@github.com:Cyxno/unraid-dashboard.git
cd unraid-dashboard
npm install
npm run dev   # http://localhost:3000 (demo data without an Unraid server)
```

Point `UNRAID_URL`/`UNRAID_API_KEY` at a real (or placeholder) Unraid API for
non-demo data. Never commit real credentials.

## Gates (all required before a PR)

```sh
npm test           # node:test suite (600+ tests)
npm run lint       # eslint, 0 errors
npm run typecheck  # tsc --noEmit
npm run build      # production build
node scripts/visual-regression.mjs   # visual + layout gates (local chrome on :9223)
```

The visual harness captures pages at phone/desktop widths against the running
app (`BASE_URL` env, default `http://127.0.0.1:8090`), asserts no horizontal
overflow, that overlays fit the viewport, that columns stay balanced, and
pixel-compares against recorded baselines (`--update` re-records intentional
changes).

## Expectations

- **Security first**: no secrets in code, bundles, logs or docs; the main app
  never gains Docker-socket access; the Agent API stays read-only; mutations
  stay guarded and audited.
- **Verified actions only**: never add a lifecycle action the Unraid API does
  not verifiably expose (no restart emulation).
- **Layout**: use the shared primitives (`PageStack`, `SectionStack`,
  `AdaptiveColumns`) and spacing tokens — no page-specific magic margins; the
  layout gates must stay green.
- **Tests**: behavior changes need coverage; regression-prone bugs get a
  failing-test-first fix.
- **Docs**: user-visible changes update the relevant docs and, when visual,
  `docs/screenshots/` (capture from demo data only).

## Pull requests

Small, focused PRs with a clear description: what changed, why, and which
gates were run. Screenshots for UI changes. If a change affects the update
pipeline or security boundaries, call it out explicitly.
