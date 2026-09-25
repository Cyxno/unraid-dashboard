#!/bin/sh
# =============================================================================
# Safe production update for the unraid-dashboard container.
#
# What it does:
#   1. Records the current container's image + full run configuration
#   2. Pulls the requested image (default: the currently-running tag)
#   3. Stops + removes the old container, recreating it with the SAME
#      env vars (incl. UNRAID_* and PROMETHEUS_URL), network mode, port
#      mappings, restart policy and volumes
#   4. Waits for /api/health to pass
#   5. On failure: automatically rolls back to the previous image
#
# The container is NOT modified in any other way; unrelated containers
# are never touched. No Watchtower.
#
# Usage:
#   ./update-dashboard.sh [image]
#     image   optional, e.g. ghcr.io/cyxno/unraid-dashboard:0.3.0
#             default: whatever tag the running container uses
# =============================================================================
set -eu

NAME="unraid-dashboard"

CURRENT_IMAGE=$(docker inspect "$NAME" --format '{{.Config.Image}}' 2>/dev/null || true)
if [ -z "$CURRENT_IMAGE" ]; then
  echo "ERROR: container '$NAME' not found — run once from an existing install." >&2
  exit 1
fi

TARGET_IMAGE="${1:-$CURRENT_IMAGE}"

echo "==> Current image: $CURRENT_IMAGE"
echo "==> Target image:  $TARGET_IMAGE"

# --- capture current configuration ------------------------------------------
NETWORK_MODE=$(docker inspect "$NAME" --format '{{.HostConfig.NetworkMode}}')
RESTART_POLICY=$(docker inspect "$NAME" --format '{{.HostConfig.RestartPolicy.Name}}')
HOSTNAME_CFG=$(docker inspect "$NAME" --format '{{.Config.Hostname}}')

# Port bindings in docker run form: -p 8090:8090/tcp
PORT_ARGS=""
docker inspect "$NAME" --format '{{range $p, $b := .NetworkSettings.Ports}}{{$p}} {{$b}} {{end}}' | tr ' ' '\n' > /dev/null || true
PORTS_JSON=$(docker inspect "$NAME" --format '{{json .HostConfig.PortBindings}}')
PORT_ARGS=$(docker inspect "$NAME" --format '{{range $port, $bindings := .HostConfig.PortBindings}}{{range $bindings}}-p {{.HostIp}}:{{.HostPort}}:{{$port}} {{end}}{{end}}')

# Binds: -v /a:/b:rw
VOLUME_ARGS=$(docker inspect "$NAME" --format '{{range .HostConfig.Binds}}-v {{.}} {{end}}')

# Env: preserve everything currently set (UNRAID_URL, UNRAID_API_KEY,
# PROMETHEUS_URL, PORT, ...). Build-provenance vars are excluded so the
# NEW image's own values take effect. Written to a temp file, 600 perms.
ENV_FILE=$(mktemp)
trap 'rm -f "$ENV_FILE"' EXIT
docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -vE '^(PATH|NODE_VERSION|YARN_VERSION|NODE_ENV|HOSTNAME|HOME|NEXT_TELEMETRY_DISABLED|APP_VERSION|GIT_SHA|BUILD_TIME|IMAGE_REF)=' \
  > "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Extra host config flags worth preserving
EXTRA_ARGS=""
[ "$RESTART_POLICY" != "" ] && [ "$RESTART_POLICY" != "no" ] && EXTRA_ARGS="$EXTRA_ARGS --restart $RESTART_POLICY"

echo "==> Pulling $TARGET_IMAGE..."
if ! docker pull "$TARGET_IMAGE"; then
  if docker image inspect "$TARGET_IMAGE" >/dev/null 2>&1; then
    echo "==> Pull failed (private registry?) but image exists locally — continuing."
  else
    echo "ERROR: pull failed and image is not local (private GHCR package? run scripts/login-ghcr.sh once)." >&2
    exit 1
  fi
fi

echo "==> Recreating container..."
docker rm -f "$NAME" >/dev/null

# shellcheck disable=SC2086
if ! docker run -d \
  --name "$NAME" \
  --network "$NETWORK_MODE" \
  $EXTRA_ARGS \
  $PORT_ARGS \
  $VOLUME_ARGS \
  --env-file "$ENV_FILE" \
  "$TARGET_IMAGE" >/dev/null; then
  echo "!!! New container failed to start — rolling back to $CURRENT_IMAGE"
  docker rm -f "$NAME" >/dev/null || true
  # shellcheck disable=SC2086
  docker run -d \
    --name "$NAME" \
    --network "$NETWORK_MODE" \
    $EXTRA_ARGS \
    $PORT_ARGS \
    $VOLUME_ARGS \
    --env-file "$ENV_FILE" \
    "$CURRENT_IMAGE" >/dev/null
  echo "Rollback complete."
  exit 1
fi

# --- health verification ------------------------------------------------------
echo "==> Waiting for health..."
ATTEMPTS=0
until docker inspect "$NAME" --format '{{.State.Health.Status}}' 2>/dev/null | grep -q healthy; do
  ATTEMPTS=$((ATTEMPTS + 1))
  if [ "$ATTEMPTS" -ge 24 ]; then
    echo "!!! Container not healthy after 2 minutes — rolling back."
    docker rm -f "$NAME" >/dev/null || true
    # shellcheck disable=SC2086
    docker run -d \
      --name "$NAME" \
      --network "$NETWORK_MODE" \
      $EXTRA_ARGS \
      $PORT_ARGS \
      $VOLUME_ARGS \
      --env-file "$ENV_FILE" \
      "$CURRENT_IMAGE" >/dev/null
    echo "Rollback complete."
    exit 1
  fi
  sleep 5
done

echo "==> Verifying live API..."
# PORT env may differ from mapped host port; probe from inside the container network.
PORT_ENV=$(docker exec "$NAME" printenv PORT 2>/dev/null || echo 3000)
HTTP_CODE=""
if [ "$NETWORK_MODE" = "host" ]; then
  HTTP_CODE=$(docker exec "$NAME" node -e "
    fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/overview?window=5m')
      .then(r => { console.log(r.status); })
      .catch(() => console.log(0))
  " 2>/dev/null | tail -1)
else
  HTTP_CODE=$(docker exec "$NAME" node -e "
    fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/overview?window=5m')
      .then(r => { console.log(r.status); })
      .catch(() => console.log(0))
  " 2>/dev/null | tail -1)
fi

if [ "$HTTP_CODE" != "200" ]; then
  echo "!!! /api/overview returned '$HTTP_CODE' — rolling back."
  docker rm -f "$NAME" >/dev/null || true
  # shellcheck disable=SC2086
  docker run -d \
    --name "$NAME" \
    --network "$NETWORK_MODE" \
    $EXTRA_ARGS \
    $PORT_ARGS \
    $VOLUME_ARGS \
    --env-file "$ENV_FILE" \
    "$CURRENT_IMAGE" >/dev/null
  echo "Rollback complete."
  exit 1
fi

echo "==> Update complete: $NAME is healthy and serving live data."
docker ps --filter "name=$NAME" --format 'table {{.Image}}\t{{.Status}}\t{{.Ports}}'
