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
WORK="$(mktemp -d)"
CONTAINER_FIXTURE="/fixture"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  echo "SMOKE FAIL: $1"
  docker logs "$NAME" 2>&1 | tail -20 || true
  exit 1
}

# --- Fase 27/28: expected files present inside the built image ---------------
for f in server.js inventory.js recreate.js compose.js; do
  if ! docker run --rm --entrypoint sh "$IMAGE" -c "test -f /helper/$f" >/dev/null 2>&1; then
    fail "/helper/$f missing from image $IMAGE"
  fi
done
echo "==> image filesystem OK (inventory.js + entrypoint present)"

# --- Fase 11/12: boot with mock docker, bounded health deadline --------------
# Wrapper dir forces MOCK_DOCKER_DIR to the fixture; mounted read-only so the
# mock works inside the container (the wrapper dir itself must be mounted).
mkdir -p "$WORK/bin"
cat > "$WORK/bin/docker" <<'EOF'
#!/bin/sh
export MOCK_DOCKER_DIR="/fixture"
exec "/fixture/docker" "$@"
EOF
chmod +x "$WORK/bin/docker"

# Published port with an AUTO-assigned host port (works on CI runners and on
# the production host alike); the real port is resolved via `docker port`.
docker run -d --name "$NAME" -p "127.0.0.1::8790" \
  -v "${FIXTURE_DIR}:${CONTAINER_FIXTURE}:ro" \
  -v "$WORK/bin:/mockbin:ro" \
  -e HELPER_PORT=8790 -e HELPER_BIND=0.0.0.0 \
  -e UPDATE_HELPER_TOKEN=smoke-token-smoke-token-smoke-token \
  --entrypoint sh "$IMAGE" \
  -c "export PATH=/mockbin:\$PATH; exec node server.js" >/dev/null

HOST_PORT=$(docker port "$NAME" 8790/tcp | head -1 | sed 's/.*://')
[ -n "$HOST_PORT" ] || fail "no published port resolved"
echo "==> container up, port resolved: $HOST_PORT"

DEADLINE=$(( $(date +%s) + 60 ))
healthy=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if curl -sf -m 3 "http://127.0.0.1:$HOST_PORT/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
[ -n "$healthy" ] || fail "helper did not become healthy within 60s"

# --- version contract ---------------------------------------------------------
BODY=$(curl -sf -m 5 "http://127.0.0.1:$HOST_PORT/health")
echo "$BODY" | grep -q "\"version\":\"$EXPECTED\"" || fail "version mismatch: $BODY"

# --- Fase 5: FRESH inventory must succeed on a brand-new container -----------
INV=$(curl -sf -m 30 -H "authorization: Bearer smoke-token-smoke-token-smoke-token" "http://127.0.0.1:$HOST_PORT/inventory" || {
  fail "fresh /inventory did not succeed (refresh failure on a brand-new container)";
})
echo "$INV" | grep -q '"structurallyDegraded":false' || fail "inventory structurally degraded: $INV"
echo "$INV" | grep -q '"inspectFailures":0' || fail "inspect failures on fresh refresh: $INV"
COUNT=$(node -e "const d=JSON.parse(process.argv[1]); console.log(d.containers.length + '|' + (d.diagnostics?.imageIdCoverage ?? 0))" "$INV")
echo "==> fresh inventory OK: containers/imageIdCoverage = $COUNT"
case "$COUNT" in
  *"|"0) fail "imageId coverage is 0 — structurally impossible for a real inspect batch" ;;
esac

# --- Fase 6: pipeline must be healthy, not just the process ------------------
BODY=$(curl -sf -m 5 "http://127.0.0.1:$HOST_PORT/health")
echo "$BODY" | grep -q '"inventoryStatus":"healthy"' || fail "inventoryStatus not healthy: $BODY"

echo "==> helper image smoke PASS ($IMAGE @ $EXPECTED)"
