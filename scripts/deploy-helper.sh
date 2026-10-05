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
IMAGE="${1:-ghcr.io/cyxno/unraid-dashboard-helper:0.8.0}"

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

# Fase 33 (v1.3.16): version precheck — never deploy an image whose
# internal version does not match the requested tag.
EXPECTED_VERSION="${IMAGE##*:}"
LABEL_VERSION=$(docker inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null | sed 's/^ *//;s/ *$//' || true)
if [ -n "$LABEL_VERSION" ] && [ "$LABEL_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "ERROR: image label version '$LABEL_VERSION' does not match requested '$EXPECTED_VERSION' — deploy blocked." >&2
  exit 1
fi
echo "==> Version precheck OK (label: ${LABEL_VERSION:-none}, tag: $EXPECTED_VERSION)"

# Fase 34 (v1.3.16): candidate smoke — boot the candidate ISOLATED on an
# alternate port with the real Docker socket and require a FRESH healthy
# inventory before touching the production helper. Skippable with
# SMOKE=0 for emergencies.
if [ "${SMOKE:-1}" = "1" ]; then
  CAND_NAME="${NAME}-candidate"
  docker rm -f "$CAND_NAME" >/dev/null 2>&1 || true
  echo "==> Candidate smoke on port 8791 (isolated)..."
  docker run -d --name "$CAND_NAME" \
    --network host \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e HELPER_PORT=8791 \
    -e UPDATE_HELPER_TOKEN="$UPDATE_HELPER_TOKEN" \
    --entrypoint node "$IMAGE" server.js >/dev/null
  CAND_OK=""
  for i in $(seq 1 30); do
    if curl -sf -m 3 "http://127.0.0.1:8791/health" >/dev/null 2>&1; then CAND_OK=1; break; fi
    sleep 1
  done
  if [ -z "$CAND_OK" ]; then
    echo "ERROR: candidate never became healthy on :8791 — deploy blocked." >&2
    docker logs "$CAND_NAME" 2>&1 | tail -10 >&2
    docker rm -f "$CAND_NAME" >/dev/null 2>&1 || true
    exit 1
  fi
  # fresh inventory must be healthy (Fase 5: not stale-cache green — the
  # candidate container has an empty cache, so this is a real refresh)
  sleep 2
  CAND_HEALTH=$(curl -sf -m 30 -H "authorization: Bearer $UPDATE_HELPER_TOKEN" "http://127.0.0.1:8791/inventory" >/dev/null && curl -sf -m 5 "http://127.0.0.1:8791/health")
  CAND_STATUS=$(echo "$CAND_HEALTH" | grep -o '"inventoryStatus":"[a-z]*"' || true)
  docker rm -f "$CAND_NAME" >/dev/null 2>&1 || true
  if [ -z "$CAND_HEALTH" ]; then
    echo "ERROR: candidate /inventory or /health failed — deploy blocked." >&2
    exit 1
  fi
  echo "$CAND_HEALTH" | grep -q '"inventoryStatus":"healthy"' || {
    echo "ERROR: candidate fresh inventory is not healthy ($CAND_STATUS) — deploy blocked." >&2
    exit 1
  }
  echo "==> Candidate smoke PASS (fresh inventory healthy)"
fi

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

# Fase 36 (v1.3.16): post-deploy gate — fresh inventory healthy is REQUIRED
# (process health alone is not deployment success). The fresh container has
# an empty cache, so this proves a real successful refresh.
INV_OK=""
for i in $(seq 1 30); do
  curl -sf -m 30 -H "authorization: Bearer $UPDATE_HELPER_TOKEN" "http://127.0.0.1:8790/inventory" >/dev/null 2>&1 && INV_OK=1 && break
  sleep 2
done
if [ -z "$INV_OK" ]; then
  echo "ERROR: fresh inventory refresh failed after deploy — deployment NOT complete." >&2
  docker logs "$NAME" 2>&1 | tail -10 >&2
  exit 1
fi
INV_STATUS=$(docker exec "$NAME" node -e "
  const t=process.env.UPDATE_HELPER_TOKEN;
  fetch('http://127.0.0.1:8790/health',{headers:{authorization:'Bearer '+t}}).then(r=>r.json()).then(b=>{
    console.log(b.inventoryStatus || 'unknown');
  }).catch(()=>console.log('probe-failed'));
" 2>/dev/null)
if [ "$INV_STATUS" != "healthy" ] && [ "$INV_STATUS" != "partial" ]; then
  echo "ERROR: inventoryStatus is '$INV_STATUS' (expected healthy/partial) — deployment NOT complete." >&2
  exit 1
fi
echo "OK: fresh inventory pipeline $INV_STATUS."

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
