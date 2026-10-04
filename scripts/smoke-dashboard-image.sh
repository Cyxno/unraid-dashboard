#!/bin/sh
# =============================================================================
# Dashboard image boot smoke (release gate).
# Boots the built dashboard image and requires, with bounded timeouts:
#   1. process alive, /api/health ok
#   2. /api/version reports the EXPECTED version + a git SHA (build metadata)
#   3. PWA manifest + service worker + root page served (Fase 21)
#   4. SSE endpoint opens with a hello event (Fase 22)
# Exits non-zero on any failure; prints the last container logs (no secrets).
# Usage: scripts/smoke-dashboard-image.sh <image> <expected-version>
# =============================================================================
set -eux

IMAGE="${1:?usage: smoke-dashboard-image.sh <image> <expected-version>}"
EXPECTED="${2:?usage: smoke-dashboard-image.sh <image> <expected-version>}"
NAME="beacon-smoke-dash-$$"
SMOKE_SECRET="smoke-proxy-secret"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

fail() {
  echo "SMOKE FAIL: $1"
  echo "::error::dashboard-image smoke: $1"
  exit 1
}

auth_curl() {
  curl "$@" -H "x-dashboard-auth-token: $SMOKE_SECRET" -H "X-Forwarded-User: smoke"
}

# Published port with AUTO-assigned host port (CI-runner + host compatible).
docker run -d --name "$NAME" -p "127.0.0.1::8090" \
  -e PORT=8090 -e HOSTNAME=0.0.0.0 -e AUTH_MODE=proxy -e NODE_ENV=production \
  -e AUTH_PROXY_SECRET="$SMOKE_SECRET" \
  -e UNRAID_URL=http://127.0.0.1:442 -e UNRAID_API_KEY=smoke-not-a-real-key \
  "$IMAGE" >/dev/null

HOST_PORT=$(docker port "$NAME" 8090/tcp | head -1 | sed 's/.*://')
[ -n "$HOST_PORT" ] || fail "no published port resolved"
echo "==> container up, port resolved: $HOST_PORT"

DEADLINE=$(( $(date +%s) + 90 ))
healthy=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if curl -sf -m 3 "http://127.0.0.1:$HOST_PORT/api/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
[ -n "$healthy" ] || fail "dashboard did not become healthy within 90s"

# version + build metadata contract (Fase 9/10)
VER=$(auth_curl -sf -m 10 "http://127.0.0.1:$HOST_PORT/api/version")
echo "$VER" | grep -q "\"version\":\"$EXPECTED\"" || fail "dashboard version mismatch: $VER"
echo "$VER" | grep -q '"gitSha":"' || fail "build metadata (gitSha) missing: $VER"

# PWA + static smoke (Fase 21)
for path in / /manifest.webmanifest /sw.js; do
  CODE=$(auth_curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:$HOST_PORT$path")
  [ "$CODE" = "200" ] || fail "$path returned $CODE"
done

# SSE smoke (Fase 22): hello event within 8s
SSE=$(auth_curl -s -N -m 8 -H 'Accept: text/event-stream' "http://127.0.0.1:$HOST_PORT/api/events" | head -2)
echo "$SSE" | grep -q 'event:' || fail "SSE did not open: $SSE"

echo "==> dashboard image smoke PASS ($IMAGE @ $EXPECTED)"
