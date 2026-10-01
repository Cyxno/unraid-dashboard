<!--
Thanks for contributing to Beacon! Keep PRs small and focused.
Security-relevant changes (auth, update pipeline, Docker access, the
Agent API) must call out the security impact explicitly — see
CONTRIBUTING.md and docs/SECURITY.md.
-->

## What changed and why

<!-- What does this PR do, and what problem does it solve? -->

## How was it tested?

<!-- Run the gates and list them: -->

- [ ] `npm run lint` (0 errors)
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `node scripts/visual-regression.mjs` (required for UI changes; re-record with `--update` only for intentional visual changes)

## Security impact

<!-- Does this touch auth, secrets, Docker access, the update pipeline or
     the Agent API? If yes, explain why the boundaries in docs/SECURITY.md
     are preserved. If not, write "none". -->
