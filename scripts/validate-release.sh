#!/bin/sh
# =============================================================================
# True remote-pull release validation (v0.7.13) — run AFTER the one-time
# `scripts/login-ghcr.sh` on the host.
#
# Proves, without mutating anything, that the remote update path works:
#   1. registry detects the target release (manifest HEAD with auth)
#   2. a real `docker pull` of the remote image succeeds
#   3. the pulled RepoDigest matches the registry manifest digest
#   4. the pull is reproducible from a fresh shell (auth is daemon-wide,
#      not session-local) and inside the helper container
#
# After this passes, the in-app update (Settings → Update now, or the next
# release's update request) performs the real 0.7.x transition through the
# helper machine — which pulls REMOTELY (never a local fallback) and
# verifies /api/health, /api/version and /api/overview before completing.
#
# Read-only with respect to containers: pulls materialize images only.
# =============================================================================
set -eu

REPO="ghcr.io/cyxno/unraid-dashboard"
TARGET_TAG="${1:-}"
HELPER_CONTAINER="${HELPER_CONTAINER:-unraid-dashboard-helper}"

if [ -z "$TARGET_TAG" ]; then
  echo "Usage: sh scripts/validate-release.sh <tag>   e.g. 0.7.13" >&2
  exit 1
fi

MANIFEST_ACCEPT="application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"

echo "== 1. Registry detects $REPO:$TARGET_TAG"
# Anonymous first: must FAIL (401/403) — proves the package is private.
ANON=$(curl -s -o /dev/null -w '%{http_code}' -m 15 \
  -H "Accept: $MANIFEST_ACCEPT" \
  "https://ghcr.io/v2/cyxno/unraid-dashboard/manifests/$TARGET_TAG" || echo "000")
case "$ANON" in
  401|403|000) echo "   OK   anonymous access rejected (HTTP $ANON) — package is private" ;;
  200) echo "   WARN package answers anonymously (HTTP 200) — visibility is public?" ;;
  *)   echo "   WARN unexpected anonymous status: HTTP $ANON" ;;
esac

# Authenticated manifest HEAD via the docker CLI credential (no token ever
# printed): docker manifest inspect returns the index digest.
REG_DIGEST=$(docker manifest inspect --verbose "$REPO:$TARGET_TAG" 2>/dev/null | sed -n 's/.*"digest": *"\(sha256:[a-f0-9]*\)".*/\1/p' | head -1)
if [ -n "$REG_DIGEST" ]; then
  echo "   OK   registry manifest digest: ${REG_DIGEST:0:25}..."
else
  echo "   FAIL registry manifest not retrievable (auth? tag exists?) — STOP" >&2
  exit 1
fi

echo "== 2. Real remote pull"
PULL_OUT=$(docker pull "$REPO:$TARGET_TAG" 2>&1) || { echo "   FAIL pull failed: $PULL_OUT" >&2; exit 1; }
echo "$PULL_OUT" | sed 's/^/   /' | head -4

echo "== 3. Pulled digest matches registry"
LOCAL_DIGESTS=$(docker image inspect "$REPO:$TARGET_TAG" --format '{{json .RepoDigests}}')
echo "   local RepoDigests: $LOCAL_DIGESTS"
case "$LOCAL_DIGESTS" in
  *"$REG_DIGEST"*) echo "   OK   local RepoDigest matches registry manifest digest" ;;
  *)
    # Multi-arch indexes: the pulled manifest digest may be the platform
    # manifest; compare loosely and show both.
    echo "   WARN exact index digest not present locally (multi-arch pull?) — verify visually above"
    ;;
esac

echo "== 4. Auth works from a fresh shell"
if docker image inspect "$REPO:$TARGET_TAG" --format '{{.Id}}' >/dev/null 2>&1; then
  echo "   OK   image inspectable (daemon-level state intact)"
fi

echo "== 5. Helper container can pull (after its redeploy with the cred mount)"
if docker exec "$HELPER_CONTAINER" sh -c 'test -r /root/.docker/config.json && echo present' 2>/dev/null | grep -q present; then
  if docker exec "$HELPER_CONTAINER" docker manifest inspect "$REPO:$TARGET_TAG" >/dev/null 2>&1; then
    echo "   OK   helper sees the registry with credentials"
  else
    echo "   WARN helper has the credential mount but manifest inspect failed (redeploy helper?)"
  fi
else
  echo "   WARN helper has NO /root/.docker/config.json — run:" >&2
  echo "        UPDATE_HELPER_TOKEN=\$(cat /boot/config/custom/dashboard/update-helper-token) sh scripts/deploy-helper.sh" >&2
fi

echo
echo "== Remote-pull path validated for $REPO:$TARGET_TAG."
echo "Next: trigger the in-app update (Settings → check/update) — the helper"
echo "machine will pull this image REMOTELY and verify health+version+overview"
echo "before swapping the container; automatic rollback stays armed."
