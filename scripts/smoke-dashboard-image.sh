#!/bin/sh
# =============================================================================
# Dashboard image boot smoke (release gate).
# Boots the built dashboard image and requires, with bounded timeouts:
#   1. process alive, /api/health ok
#   2. /api/version reports the EXPECTED version + a git SHA (build metadata)
#   3. PWA manifest + service worker + root page served (Fase 21)
#   4. SSE endpoint opens with a hello event (Fase 22)
# Exits non-zero on any failure; prints last container logs (no secrets).
# Usage: scripts/smoke-dashboard-image.sh <image> <expected-version>
# =============================================================================
set -eu

IMAGE="${1:?usage: smoke-dashboard-image.sh <image> <expected-version>}"
EXPECTED="${2:?usage: smoke-dashboard-image.sh <image> <expected-version>}"
NAME="beacon-smoke-dash-$$"
SMOKE_SECRET="smoke-proxy-secret"
auth_curl() {
  curl "$@" -H "x-dashboard-auth-token: $SMOKE_SECRET" -H "X-Forwarded-User: smoke";
}
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Host networking with an ephemeral port (same reasoning as helper smoke).
# Proxy auth mode with a known secret + UNRAID env (version route validates
# env presence; the smoke never contacts a real Unraid host).
docker run -d --name "$NAME" --network host \
  -e PORT=18099 -e HOSTNAME=127.0.0.1 -e AUTH_MODE=proxy -e NODE_ENV=production \
  -e AUTH_PROXY_SECRET="$SMOKE_SECRET" \
  -e UNRAID_URL=http://127.0.0.1:442 -e UNRAID_API_KEY=smoke-not-a-real-key \
  "$IMAGE" >/dev/null

DEADLINE=$(( $(date +%s) + 90 ))
healthy=""
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  if curl -sf -m 3 "http://127.0.0.1:18099/api/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 1
done
if [ -z "$healthy" ]; then
  echo "SMOKE FAIL: dashboard did not become healthy within 90s; last logs:"
  docker logs "$NAME" 2>&1 | tail -25
  exit 1
fi

# version + build metadata contract (Fase 9/10)
VER=$(auth_curl -sf -m 10 "http://127.0.0.1:18099/api/version")
echo "$VER" | grep -q "\"version\":\"$EXPECTED\"" || { echo "SMOKE FAIL: dashboard version mismatch: $VER"; exit 1; }
echo "$VER" | grep -q '"gitSha":"' || { echo "SMOKE FAIL: build metadata (gitSha) missing: $VER"; exit 1; }

# PWA + static smoke (Fase 21)
for path in / /manifest.webmanifest /sw.js; do
  CODE=$(auth_curl -s -o /dev/null -w '%{http_code}' -m 10 "http://127.0.0.1:18099$path")
  [ "$CODE" = "200" ] || { echo "SMOKE FAIL: $path returned $CODE"; exit 1; }
done

# SSE smoke (Fase 22): hello event within 8s
SSE=$(auth_curl -s -N -m 8 -H 'Accept: text/event-stream' "http://127.0.0.1:18099/api/events" | head -2)
echo "$SSE" | grep -q 'event:' || { echo "SMOKE FAIL: SSE did not open: $SSE"; exit 1; }

echo "==> dashboard image smoke PASS ($IMAGE @ $EXPECTED)"
