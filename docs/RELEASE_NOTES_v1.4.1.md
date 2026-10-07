# Beacon v1.4.1

Patch release on top of v1.4.0: fixes the Web Push registration persistence
race (subscriptions could disappear after engine-cycle saves) and aligns the
helper release version.

## Fixed

- **Web Push registrations survive restarts and engine cycles**: notification
  routes (POST / test / config / history / delete) mutated a freshly reloaded
  disk copy while the notification engine works on the shared in-memory
  state — the engine's next save wiped freshly registered subscriptions.
  All notification routes now mutate the same shared working set as the
  engine. Boot-order hardened: the engine no longer runs on an empty state
  before the first disk load.
- Helper release version aligned to 1.4.1.

## Upgrade

```
ghcr.io/cyxno/unraid-dashboard:1.4.1
ghcr.io/cyxno/unraid-dashboard-helper:1.4.1
ghcr.io/cyxno/unraid-dashboard:latest
ghcr.io/cyxno/unraid-dashboard-helper:latest
```

Existing installs: Settings → Updates, or your documented update flow.
After updating, re-run Settings → Notifications → "Enable Web Push" /
"Repair Web Push" on each push device (one-time; subscriptions registered
before v1.3.22 may need one re-registration).
