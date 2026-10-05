#!/bin/sh
# =============================================================================
# Published-artifact verification (Fase 54): pull an exact published tag and
# run the same boot smoke as the pre-publish gate. Every failure mode is
# emitted as a ::error:: annotation so the cause is visible via the Checks
# API without admin log access.
# Usage: scripts/verify-published.sh <kind: dashboard|helper> <image> <expected-version>
# =============================================================================
set -eu

KIND="${1:?usage: verify-published.sh <dashboard|helper> <image> <expected-version> [expected-channel]}"
IMAGE="${2:?}"
EXPECTED="${3:?}"
EXPECTED_CHANNEL="${4:-}"

note() { echo "::error::verify-published[$KIND]: $1" || true; }

echo "==> pulling $IMAGE"
if ! docker pull "$IMAGE" >/tmp/pull.log 2>&1; then
  note "docker pull failed for $IMAGE"
  tail -5 /tmp/pull.log | while IFS= read -r l; do note "pull: $l"; done
  exit 1
fi
echo "==> pull OK"

# image-level identity check before boot (Fase 10/28).
# RAW assertions first (v1.3.18): our own artifacts must be canonical with
# NO trimming — the trimmed comparison below stays only as a defensive
# second layer against third-party/registry oddities.
RAW_VERSION=$(docker inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || true)
[ "$RAW_VERSION" = "$EXPECTED" ] || { note "RAW version label '$RAW_VERSION' != '$EXPECTED' (exact match required, no trimming)"; exit 1; }
RAW_REVISION=$(docker inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' 2>/dev/null || true)
[ -n "$RAW_REVISION" ] || { note "RAW revision label missing"; exit 1; }
[ "$RAW_REVISION" = "${RAW_REVISION%%*( )}" ] || { note "RAW revision label has trailing whitespace"; exit 1; }
RAW_CHANNEL=$(docker inspect "$IMAGE" --format '{{index .Config.Labels "org.cyxno.image.channel"}}' 2>/dev/null || true)
if [ -n "$EXPECTED_CHANNEL" ] && [ "$RAW_CHANNEL" != "$EXPECTED_CHANNEL" ]; then
  note "RAW channel label '$RAW_CHANNEL' != expected '$EXPECTED_CHANNEL'"
  exit 1
fi
LABEL_VERSION=$(docker inspect "$IMAGE" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null | sed 's/^ *//;s/ *$//' || true)
if [ -n "$LABEL_VERSION" ] && [ "$LABEL_VERSION" != "$EXPECTED" ]; then
  note "label version '$LABEL_VERSION' != expected '$EXPECTED'"
  exit 1
fi

if [ "$KIND" = "helper" ]; then
  sh "$(dirname "$0")/smoke-helper-image.sh" "$IMAGE" "$EXPECTED" || {
    note "helper boot smoke failed against the published image"
    exit 1
  }
else
  sh "$(dirname "$0")/smoke-dashboard-image.sh" "$IMAGE" "$EXPECTED" || {
    note "dashboard boot smoke failed against the published image"
    exit 1
  }
fi
echo "==> published artifact verified: $IMAGE @ $EXPECTED"
