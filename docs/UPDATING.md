# Updating Beacon

Beacon updates are provenance-verified end to end: a git tag builds in GitHub
Actions, lands in GHCR, and an update is only applied after the running
container verifies the **registry digest matches the repository digest**.

## Option A — in-app (recommended, needs the update helper)

1. **Settings → Updates** → *Check for updates*. The check reads the registry
   without mutating anything.
2. **Update to vX.Y.Z** → confirm. The helper:
   - pulls `ghcr.io/cyxno/unraid-dashboard:X.Y.Z` from GHCR (strict remote —
     local images are never substituted),
   - verifies the version label, git revision and **repo ↔ registry digest**,
   - recreates the container with identical configuration,
   - health-checks it and **rolls back automatically** on any failure.
3. Progress streams live (SSE) in the Updates card; history is persisted to
   `/app/data/update-history.jsonl` and shown in Docker → History.

If the GHCR package is private, the host needs `read:packages` once via
`sh scripts/login-ghcr.sh` (a PAT, input hidden, never stored in Beacon).
For a public package no login is needed.

## Option B — host-side script

```sh
sh scripts/update-dashboard.sh ghcr.io/cyxno/unraid-dashboard:X.Y.Z
```

The script captures the current configuration, pulls the image, recreates the
container identically, health-checks it and rolls back automatically.

## Strict-mode guarantees

- `usedLocalImage: false` — the image came from the registry, not a local tag.
- `digestMatch: true` — repository digest equals registry digest.
- The Operations page shows the chain and a **Registry verified** badge.

## Rollback

- In-app: Settings → Updates → rollback candidates (validated local releases).
- Host-side: `docker tag unraid-dashboard:previous` image and recreate, or
  re-run `update-dashboard.sh` with the previous tag.

## Update history

Every update records actor, from/to versions, duration, source (registry vs
local), digest match and any error. Full trail: Docker → History; exportable
as CSV.
