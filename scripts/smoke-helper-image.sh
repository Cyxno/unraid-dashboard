#!/bin/sh
# =============================================================================
# Helper image boot smoke (release gate).
# Boots the built helper image with a MOCKED docker CLI (fixture fixtures),
# then requires, with bounded timeouts:
#   1. process alive and /health ok with the EXPECTED version
#   2. FRESH /inventory success (not stale cache — the container is brand new)
#   3. diagnostics healthy (no structural degradation, no failures)
#   4. helper/inventory.js present inside the image (v1.3.13 file-copy class)
# Exits non-zero on any failure; prints the last container logs (no secrets).
# Usage: scripts/smoke-helper-image.sh <image> <expected-version>
# =============================================================================
set -eu

IMAGE="${1:?usage: smoke-helper-image.sh <image> <expected-version>}"
EXPECTED="${2:?usage: smoke-helper-image.sh <image> <expected-version>}"
NAME="beacon-smoke-helper-$$"
FIXTURE_DIR="$(cd "$(dirname "$0")/../tests/fixtures/mock-docker" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d)"
CONTAINER_FIXTURE="/fixture"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# --- Fase 27/28: expected files present inside the built image ---------------
for f in server.js inventory.js recreate.js compose.js; do
  if ! docker run --rm --entrypoint sh "$IMAGE" -c "test -f /helper/$f" >/dev/null 2>&1; then
    echo "SMOKE FAIL: /helper/$f missing from image $IMAGE"
    exit 1
  fi
done
echo "==> image filesystem OK (inventory.js + entrypoint present)"

# --- Fase 11/12: boot with mock docker, bounded health deadline --------------
# Build an executable wrapper dir that forces MOCK_DOCKER_DIR to the fixture.
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<EOF
#!/bin/sh
export MOCK_DOCKER_DIR="$CONTAINER_FIXTURE"
exec "$CONTAINER_FIXTURE/docker" "\$@"
EOF
chmod +x "$WORK/bin/docker"

HOST_PORT="${HOST_PORT:-18790}"
# Host networking with an ephemeral port: the helper binds 127.0.0.1 only,
# works identically on CI runners and on the Unraid host (published ports
# are unreliable on the production host's network setup).
docker run -d --name "$NAME" --network host \
  -v "${FIXTURE_DIR}:${CONTAINER_FIXTURE}:ro" \
  -v "$WORK/bin:/mockbin:ro" \
  -e HELPER_PORT="$HOST_PORT" \
  -e UPDATE_HELPER_TOKEN=smoke-token-smoke-token-smoke-token \
  --entrypoint sh "$IMAGE" \
  -c "export PATH=/mockbin:\$PATH; exec node server.js" >/dev/null

DEADLINE=$(( $(date +%s) + 60 ))
healthy=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if curl -sf -m 3 "http://127.0.0.1:$HOST_PORT/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
if [ -z "$healthy" ]; then
  echo "SMOKE FAIL: helper did not become healthy within 60s; last logs:"
  docker logs "$NAME" 2>&1 | tail -20
  exit 1
fi

# --- version contract ---------------------------------------------------------
BODY=$(curl -sf -m 5 "http://127.0.0.1:$HOST_PORT/health")
echo "$BODY" | grep -q "\"version\":\"$EXPECTED\"" || { echo "SMOKE FAIL: version mismatch: $BODY"; exit 1; }

# --- Fase 5: FRESH inventory must succeed on a brand-new container -----------
INV=$(curl -sf -m 30 -H "authorization: Bearer smoke-token-smoke-token-smoke-token" "http://127.0.0.1:$HOST_PORT/inventory" || {
  echo "SMOKE FAIL: fresh /inventory did not succeed (refresh failure on a brand-new container)"; exit 1;
})
echo "$INV" | grep -q '"structurallyDegraded":false' || { echo "SMOKE FAIL: inventory structurally degraded: $INV"; exit 1; }
echo "$INV" | grep -q '"inspectFailures":0' || { echo "SMOKE FAIL: inspect failures on fresh refresh: $INV"; exit 1; }
COUNT=$(node -e "const d=JSON.parse(process.argv[1]); console.log(d.containers.length + '|' + (d.diagnostics?.imageIdCoverage ?? 0))" "$INV")
echo "==> fresh inventory OK: containers/imageIdCoverage = $COUNT"
case "$COUNT" in
  *"|"0) echo "SMOKE FAIL: imageId coverage is 0 — structurally impossible for a real inspect batch"; exit 1 ;;
esac

# --- Fase 6: pipeline must be healthy, not just the process ------------------
BODY=$(curl -sf -m 5 "http://127.0.0.1:$HOST_PORT/health")
echo "$BODY" | grep -q '"inventoryStatus":"healthy"' || { echo "SMOKE FAIL: inventoryStatus not healthy: $BODY"; exit 1; }

echo "==> helper image smoke PASS ($IMAGE @ $EXPECTED)"
