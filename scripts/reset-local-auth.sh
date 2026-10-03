#!/bin/sh
# =============================================================================
# Reset local auth: removes the local username/password and reverts Beacon
# to Trusted Network mode (no login). Also invalidates all sessions via
# the config sessionEpoch. Host-side recovery only — never exposed as a
# web endpoint.
#
# Usage: sh scripts/reset-local-auth.sh
# Requires: docker exec access to the unraid-dashboard container.
# =============================================================================
set -eu
NAME="${UNRAID_DASHBOARD_NAME:-unraid-dashboard}"

if ! docker inspect "$NAME" >/dev/null 2>&1; then
  echo "ERROR: container '$NAME' not found." >&2
  exit 1
fi

echo "==> Resetting local auth on $NAME..."
docker exec "$NAME" node -e "
const fs = require('fs');
const path = process.env.AUDIT_DIR + '/beacon-config.json';
try {
  const config = JSON.parse(fs.readFileSync(path, 'utf8'));
  config.security.mode = 'trusted';
  config.security.local = null;
  config.security.sessionEpoch = (config.security.sessionEpoch || 1) + 1;
  fs.writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log('Local auth reset: mode=trusted, sessions invalidated.');
} catch (e) {
  console.error('Failed to reset:', e.message);
  process.exit(1);
}
"
echo "==> Done. Beacon is now in Trusted Network mode (no login required)."
echo "    Restart the container to clear in-memory sessions: docker restart $NAME"
