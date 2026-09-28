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
IMAGE="${1:-ghcr.io/cyxno/unraid-dashboard-helper:0.7.14}"

if [ -z "${UPDATE_HELPER_TOKEN:-}" ]; then
  echo "ERROR: UPDATE_HELPER_TOKEN must be provided (openssl rand -hex 32)." >&2
  exit 1
fi

# Proxy-auth secret so the helper can reach protected dashboard endpoints
# when the dashboard runs AUTH_MODE=proxy (same value as AUTH_PROXY_SECRET).
DASHBOARD_AUTH_SECRET="${DASHBOARD_AUTH_SECRET:-}"

# Docker storage model detection (host-side; folder mode on a pool is the
# Unraid 7.x default, legacy installs use a loop-mounted docker.img).
DOCKER_STORAGE_MODE="${DOCKER_STORAGE_MODE:-}"
DOCKER_STORAGE_SOURCE="${DOCKER_STORAGE_SOURCE:-}"
if [ -z "$DOCKER_STORAGE_MODE" ]; then
  ROOT_MOUNT=$(awk '$2 == "/var/lib/docker" { print; exit }' /proc/mounts)
  if [ -n "$ROOT_MOUNT" ]; then
    DOCKER_STORAGE_SOURCE=$(echo "$ROOT_MOUNT" | awk '{print $1}')
    case "$DOCKER_STORAGE_SOURCE" in
      /dev/*|/mnt/*) DOCKER_STORAGE_MODE="folder" ;;
      *.img|*loop*)  DOCKER_STORAGE_MODE="image-file" ;;
      *)             DOCKER_STORAGE_MODE="unknown" ;;
    esac
  fi
fi
if [ -z "$DASHBOARD_AUTH_SECRET" ] && [ -f /boot/config/custom/dashboard/proxy-auth-secret ]; then
  DASHBOARD_AUTH_SECRET=$(cat /boot/config/custom/dashboard/proxy-auth-secret)
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
# Persistent update state (snapshots/jobs): must survive helper
# recreation so auto-rollback is never dependent on volatile /tmp.
STATE_DIR="/mnt/user/appdata/unraid-dashboard/helper-state"
mkdir -p "$STATE_DIR" && chmod 700 "$STATE_DIR"

# Compose roots: afgeleid uit de labels van draaiende containers. Elk
# working_dir wordt READ-ONLY op hetzelfde pad gemount, zodat label-paden
# geldig blijven binnen de helper. Deploy-time only.
COMPOSE_ROOTS=""
COMPOSE_MOUNTS=""
for DIR in $(docker ps --format '{{.Names}}' | while read C; do
  docker inspect "$C" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null
done | sort -u); do
  [ -z "$DIR" ] && continue
  REAL=$(realpath "$DIR" 2>/dev/null) || continue
  [ -d "$REAL" ] || continue
  COMPOSE_ROOTS="$COMPOSE_ROOTS,$REAL"
  COMPOSE_MOUNTS="$COMPOSE_MOUNTS -v $REAL:$REAL:ro"
done
COMPOSE_ROOTS=$(echo "$COMPOSE_ROOTS" | sed "s/^,//")
echo "==> Compose allowed roots: $COMPOSE_ROOTS"

# GHCR credential (v0.7.13): when the host has done the one-time
# `scripts/login-ghcr.sh`, the flash-backed credential store is bind-mounted
# READ-ONLY at /root/.docker so the helper's docker CLI can pull private
# images — across helper recreates AND host reboots. Optional: without it
# the helper still works, only private pulls fall back to local images.
DOCKER_CRED_MOUNT=""
if [ -f /boot/config/custom/dashboard/docker-cred/config.json ]; then
  DOCKER_CRED_MOUNT="-v /boot/config/custom/dashboard/docker-cred:/root/.docker:ro"
  echo "==> GHCR credential mount: enabled (read-only, flash-backed)"
else
  echo "==> GHCR credential mount: absent — private pulls need scripts/login-ghcr.sh"
fi

# Pipeline-owned projects (v0.7.13): the helper refuses mutations on these
# compose projects even if asked directly (defense in depth; the dashboard
# gate refuses first).
PIPELINE_OWNED="${PIPELINE_OWNED_PROJECTS:-tornscope}"

# Strict remote mode (v0.7.14): when UPDATE_REQUIRE_REMOTE=true the helper's
# self-update forbids the local-image fallback, requires a pulled RepoDigest
# and requires it to equal the registry index digest — used to prove the
# registry→production release chain. Opt-in per deploy.
REQUIRE_REMOTE="${UPDATE_REQUIRE_REMOTE:-false}"

docker run -d \
  --name "$NAME" \
  --network host \
  --restart unless-stopped \
  -v /var/run/docker.sock:/var/run/docker.sock \
  $COMPOSE_MOUNTS \
  $DOCKER_CRED_MOUNT \
  -v "$STATE_DIR":/helper-state:rw \
  -e UPDATE_HELPER_TOKEN="$UPDATE_HELPER_TOKEN" \
  -e DASHBOARD_AUTH_SECRET="$DASHBOARD_AUTH_SECRET" \
  -e COMPOSE_ALLOWED_ROOTS="$COMPOSE_ROOTS" \
  -e PIPELINE_OWNED_PROJECTS="$PIPELINE_OWNED" \
  -e UPDATE_REQUIRE_REMOTE="$REQUIRE_REMOTE" \
  -e DOCKER_STORAGE_MODE="$DOCKER_STORAGE_MODE" \
  -e DOCKER_STORAGE_SOURCE="$DOCKER_STORAGE_SOURCE" \
  -e STATE_DIR=/helper-state \
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
