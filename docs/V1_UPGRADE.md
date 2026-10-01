# Upgrading to v1.0 (from v0.9.16)

v1.0.0 is the stabilization milestone of the 0.9.x series: no breaking data
changes, no new required configuration. This guide covers everything needed
to move from v0.9.16 to the 1.0 line and back.

## Before you upgrade

- **Backup the data volume** (one command):
  `cp -a /mnt/user/appdata/unraid-dashboard /mnt/user/appdata/unraid-dashboard-backup-$(date +%F)`
  v1.0 uses the identical volume and file formats; the backup is insurance,
  not a requirement (verified: v0.9.16 ↔ 1.0.0-rc1 data is bidirectionally
  compatible).
- Note your current version: `curl http://<server>:8090/api/version`.
- If you use the update helper, update it together with the app (both images
  are built from the same tag).

## Required configuration (unchanged from 0.9.x)

| Variable | Purpose |
| --- | --- |
| `UNRAID_URL` | Unraid GraphQL API base URL |
| `UNRAID_API_KEY` | read-only key for all dashboards |
| `PORT` | web port (default 8090) |
| volume `/app/data` | persisted state |

## Optional configuration (unchanged)

- `PROMETHEUS_URL` — metrics, history, thermal intelligence.
- `ENABLE_ACTIONS` + `UNRAID_ACTION_API_KEY` (`DOCKER: UPDATE_ANY` only) —
  container Start/Stop.
- `UPDATE_HELPER_URL` + `UPDATE_HELPER_TOKEN` — in-app updates.
- `AGENT_API_TOKEN` — read-only machine API.
- `AUTH_MODE=proxy` + `AUTH_PROXY_SECRET` — reverse-proxy authentication.

Full reference: [CONFIGURATION.md](CONFIGURATION.md).

## Upgrade paths

### In-app (update helper configured)

Settings → Updates → *Check for updates* → **Update to v1.0.0** → confirm.
The helper pulls from GHCR, verifies the digest, recreates the container with
identical configuration, health-checks, and rolls back automatically on
failure. Progress streams live.

### Host-side

```sh
sh scripts/update-dashboard.sh ghcr.io/cyxno/unraid-dashboard:1.0.0
```

Same guarantees (config preservation, health check, rollback).

### Release candidates

Release candidates use prerelease tags (`v1.0.0-rc1`, `v1.0.0-rc2`, …). The
update helper accepts semver prereleases since helper 0.9.5; ordering is
semver-correct (`0.9.16 < 1.0.0-rc1 < 1.0.0-rc2 < 1.0.0`), so the in-app
upgrade path works for RCs too.

## Rollback

- In-app: Settings → Updates → rollback to the previous validated release.
- Host-side: `sh scripts/update-dashboard.sh ghcr.io/cyxno/unraid-dashboard:0.9.16`.
- Persisted state (audit, update history, dashboards, automation state) is
  written in the same formats by both versions — rollback after running 1.0
  loses nothing.

## Version notes

- Prerelease tags are allowed for the first time in the 1.0 line
  (`1.0.0-rc1`); the update pipeline orders prereleases below their release
  (`1.0.0-rc1 → 1.0.0` is an upgrade, never a downgrade).
- The helper rejects downgrade requests outside the explicit rollback path.

## Verification after upgrade

1. `/api/version` reports the expected version and git SHA.
2. `/api/health` returns `ok`.
3. Settings → Diagnostics: data volume writable, dashboards count preserved,
   audit file present.
4. Audit trail and update history still list pre-upgrade entries.
