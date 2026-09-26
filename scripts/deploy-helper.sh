#!/bin/sh
# =============================================================================
# Deploy/update the unraid-dashboard update helper.
#
# The helper is the ONLY component with Docker access:
#   - binds 127.0.0.1:8790 (never a published interface)
#   - updates ONLY the container 'unraid-dashboard' from the pinned repo
#     ghcr.io/cyxno/unraid-dashboard, semver tags only
#   - token-authenticated (UPDATE_HELPER_TOKEN, shared with the dashboard)
#   - single-flight, full config preservation, automatic rollback
#
# Usage:
#   UPDATE_HELPER_TOKEN=<32+ char secret> scripts/deploy-helper.sh [image]
#
# The token is required; generate once with: openssl rand -hex 32
# It is shared with the dashboard container env (UPDATE_HELPER_TOKEN) and
# never printed or committed.
# =============================================================================
set -eu

NAME="unraid-dashboard-helper"
IMAGE="${1:-ghcr.io/cyxno/unraid-dashboard-helper:0.7.0}"

if [ -z "${UPDATE_HELPER_TOKEN:-}" ]; then
  echo "ERROR: UPDATE_HELPER_TOKEN must be provided (openssl rand -hex 32)." >&2
  exit 1
fi
if [ "${#UPDATE_HELPER_TOKEN}" -lt 32 ]; then
  echo "ERROR: UPDATE_HELPER_TOKEN must be at least 32 characters." >&2
  exit 1
fi

echo "==> Pulling $IMAGE (local build tolerated)..."
docker pull "$IMAGE" 2>/dev/null || docker image inspect "$IMAGE" >/dev/null 2>&1 || {
  echo "ERROR: image neither pullable nor local: $IMAGE" >&2
  exit 1
}

echo "==> Recreating $NAME..."
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$NAME" \
  --network host \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e UPDATE_HELPER_TOKEN="$UPDATE_HELPER_TOKEN" \
  -e HELPER_PORT=8790 \
  -e DASHBOARD_PORT="${DASHBOARD_PORT:-8090}" \
  "$IMAGE" >/dev/null

echo "==> Waiting for helper health..."
ATTEMPTS=0
until [ "$(docker inspect "$NAME" --format '{{.State.Health.Status}}' 2>/dev/null)" = "healthy" ]; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 12 ]; then
    echo "ERROR: helper not healthy after 1 minute." >&2
    docker logs --tail 20 "$NAME" >&2 || true
    exit 1
  fi
  sleep 5
done

echo "==> Verifying localhost-only binding..."
if docker exec "$NAME" node -e "
  fetch('http://127.0.0.1:8790/health').then(r=>r.json()).then(b=>{
    if (!b.ok) process.exit(1);
  }).catch(()=>process.exit(1));
" 2>/dev/null; then
  echo "OK: helper healthy on 127.0.0.1:8790."
else
  echo "ERROR: helper health probe failed." >&2
  exit 1
fi

# The helper must NOT be reachable from a non-loopback address.
HELPER_IP=$(hostname -i 2>/dev/null | awk '{print $1}')
if [ -n "$HELPER_IP" ]; then
  if timeout 3 nc -z "$HELPER_IP" 8790 2>/dev/null; then
    echo "WARNING: helper port 8790 answered on $HELPER_IP — verify binding!" >&2
  else
    echo "OK: helper not reachable on $HELPER_IP:8790 (localhost only)."
  fi
fi

echo "==> Helper deployment complete."
docker ps --filter "name=$NAME" --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
