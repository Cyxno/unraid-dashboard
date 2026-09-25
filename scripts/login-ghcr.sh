#!/bin/sh
# =============================================================================
# One-time GHCR login for the Unraid host.
#
# The ghcr.io/cyxno/unraid-dashboard package is PRIVATE, so anonymous docker
# pulls fail with "unauthorized". This script authenticates the local Docker
# daemon to ghcr.io using a GitHub PAT with the minimum required scope:
#
#   read:packages
#
# Usage:
#   ./login-ghcr.sh
#
# The token is read interactively (or from stdin) — never passed as an
# argument, never echoed, never written to this repository.
# Login state is stored by Docker in the daemon's config.json (on Unraid:
# /boot/config/plugins/dockerMan/config.json), which persists across reboots.
# =============================================================================
set -eu

REGISTRY="ghcr.io"

printf 'GitHub PAT (read:packages), input hidden: '
stty -echo 2>/dev/null || true
IFS= read -r TOKEN
stty echo 2>/dev/null || true
printf '\n'

if [ -z "$TOKEN" ]; then
  echo "ERROR: no token provided." >&2
  exit 1
fi

# Login without echoing the token into process listings where avoidable.
printf '%s' "$TOKEN" | docker login "$REGISTRY" --username cyxno --password-stdin

echo "Logged in to $REGISTRY."
echo "Verifying anonymous-restricted pull..."
if docker pull ghcr.io/cyxno/unraid-dashboard:latest >/dev/null 2>&1; then
  echo "OK: docker pull ghcr.io/cyxno/unraid-dashboard:latest works."
else
  echo "WARNING: pull still fails. Check that the PAT has read:packages and" >&2
  echo "that your account has access to the cyxno/unraid-dashboard package." >&2
  exit 1
fi
