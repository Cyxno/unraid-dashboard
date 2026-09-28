#!/bin/sh
# =============================================================================
# One-time GHCR login for the Unraid host — WITH persistence (v0.7.13).
#
# The ghcr.io/cyxno/* packages are PRIVATE, so anonymous docker pulls fail
# with "unauthorized". This script authenticates Docker to ghcr.io using a
# GitHub PAT with the minimum required scope:
#
#   read:packages
#
# What it does:
#   1. reads the PAT interactively (input hidden; never an argument,
#      never echoed, never written to this repository)
#   2. `docker login ghcr.io` — the normal Docker credential store
#   3. verifies the credential with a REAL pull (pulling materializes an
#      image only; no container is touched)
#   4. persists the credential to the flash drive (0600) so it survives
#      reboots: /boot/config/custom/dashboard/docker-cred/config.json
#      (/root is RAM-backed on Unraid — without this the login dies at
#      every boot)
#   5. ensures the /boot/config/go restore block exists (recreates
#      /root/.docker/config.json at every boot)
#   6. prints the exact helper-redeploy command so the running helper
#      container picks up the credential bind mount
#
# The helper container reads the SAME flash-backed directory via a
# read-only bind mount at /root/.docker (added in deploy-helper.sh), so a
# single login covers host pulls AND helper pulls, across reboots and
# helper recreates.
#
# The token is never printed, never committed, never stored in dashboard
# env/templates, and never exposed through the API, logs or audit.
# =============================================================================
set -eu

REGISTRY="ghcr.io"
PERSIST_DIR="/boot/config/custom/dashboard/docker-cred"
PERSIST_FILE="$PERSIST_DIR/config.json"
GO_FILE="/boot/config/go"
ROOT_DOCKER_DIR="/root/.docker"

printf 'GitHub PAT (read:packages), input hidden: '
stty -echo 2>/dev/null || true
IFS= read -r TOKEN
stty echo 2>/dev/null || true
printf '\n'

if [ -z "$TOKEN" ]; then
  echo "ERROR: no token provided." >&2
  exit 1
fi

# Login without the token appearing in process listings.
printf '%s' "$TOKEN" | docker login "$REGISTRY" --username cyxno --password-stdin
unset TOKEN

echo "Logged in to $REGISTRY."
echo "Verifying with a real pull (private package, anonymous-restricted)..."
if docker pull "$REGISTRY/cyxno/unraid-dashboard:latest" >/dev/null 2>&1; then
  echo "OK: docker pull ghcr.io/cyxno/unraid-dashboard:latest works."
else
  echo "WARNING: pull still fails. Check that the PAT has read:packages and" >&2
  echo "that your account has access to the cyxno/unraid-dashboard package." >&2
  exit 1
fi

# --- persistence: flash store (survives reboot; /root does not) -----------
mkdir -p "$PERSIST_DIR"
chmod 700 "$PERSIST_DIR"
cp "$ROOT_DOCKER_DIR/config.json" "$PERSIST_FILE"
chmod 600 "$PERSIST_FILE"
echo "Persisted credential store to $PERSIST_FILE (0600)."

# --- boot restore: /boot/config/go block -----------------------------------
if ! grep -q "dashboard-ghcr-cred-start" "$GO_FILE" 2>/dev/null; then
  cat >> "$GO_FILE" <<'EOF'

# dashboard-ghcr-cred-start: restore the Docker credential store for GHCR
# (/root is RAM-backed on Unraid; the credential itself lives on the flash
# drive at /boot/config/custom/dashboard/docker-cred/config.json, 0600,
# written by scripts/login-ghcr.sh). Read scope only: read:packages.
# To revoke: delete that file and this block, then `docker logout ghcr.io`.
if [ -f /boot/config/custom/dashboard/docker-cred/config.json ]; then
  mkdir -p /root/.docker
  cp /boot/config/custom/dashboard/docker-cred/config.json /root/.docker/config.json
  chmod 600 /root/.docker/config.json
fi
# dashboard-ghcr-cred-end
EOF
  echo "Added boot-restore block to $GO_FILE."
else
  echo "Boot-restore block already present in $GO_FILE."
fi

cat <<'EOF'

Done. The running helper container needs one redeploy to pick up the
credential mount (read-only /root/.docker from the flash store):

  UPDATE_HELPER_TOKEN=$(cat /boot/config/custom/dashboard/update-helper-token) \
    sh scripts/deploy-helper.sh

After that, host AND helper pulls of ghcr.io/cyxno/* work everywhere,
including after a reboot. Nothing about the token is exposed to the
dashboard UI, API, logs or audit trail.
EOF
