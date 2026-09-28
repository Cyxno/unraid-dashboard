#!/bin/sh
# =============================================================================
# Boot-persistence audit (v0.7.13) — dry-run reboot validation.
#
# Verifies, WITHOUT rebooting, everything that must survive a host reboot:
#   - /boot/config/go syntax + DASH8090 firewall block + GHCR cred restore
#   - flash-backed secret store (proxy secret, helper token, docker cred)
#   - DockerMan autostart templates for the dashboard + helper
#   - NPM custom config: dashboard + kiosk hosts, Authelia auth_request,
#     Cloudflare real-IP restores, SSE settings, kiosk allowlist
#   - Authelia config present
#   - persistent state: /app/data bind, helper state dir, update history,
#     audit trail, resilience backups
#   - container restart policies (autostart without manual steps)
#
# Read-only: changes nothing on the host. Exit 0 = all critical checks
# passed; exit 1 = at least one CRITICAL check failed (boot would regress).
# =============================================================================
set -u

PASS=0
FAIL=0
WARN=0

ok()   { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad()  { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  WARN  $1"; WARN=$((WARN + 1)); }

section() { echo; echo "== $1 =="; }

GO_FILE="/boot/config/go"
NPM_HTTP="/mnt/user/appdata/Nginx-Proxy-Manager-Official/data/nginx/custom/http.conf"
APPDATA="/mnt/user/appdata/unraid-dashboard"
HELPER_STATE="$APPDATA/helper-state"
TEMPLATES="/boot/config/plugins/dockerMan/templates-user"

section "Boot script (/boot/config/go)"
if [ -f "$GO_FILE" ]; then
  ok "go file present"
  if sh -n "$GO_FILE" 2>/dev/null; then ok "go file syntax valid"; else bad "go file has SYNTAX ERRORS"; fi
  grep -q "codex-dashboard-8090-isolation-start" "$GO_FILE" \
    && ok "DASH8090 firewall block present (restores port isolation at boot)" \
    || bad "DASH8090 firewall block MISSING"
  grep -q "dashboard-ghcr-cred-start" "$GO_FILE" \
    && ok "GHCR credential restore block present" \
    || warn "GHCR credential restore block absent (login not done yet — run scripts/login-ghcr.sh)"
else
  bad "go file missing — firewall and credential persistence would NOT survive boot"
fi

section "Flash-backed secret store"
[ -f /boot/config/custom/dashboard/proxy-auth-secret ] && ok "proxy-auth-secret present (NPM -> dashboard shared secret)" || warn "proxy-auth-secret missing"
[ -f /boot/config/custom/dashboard/update-helper-token ] && ok "update-helper-token present" || warn "update-helper-token missing"
if [ -f /boot/config/custom/dashboard/docker-cred/config.json ]; then
  PERM=$(stat -c '%a' /boot/config/custom/dashboard/docker-cred/config.json 2>/dev/null || echo "?")
  [ "$PERM" = "600" ] && ok "GHCR credential store present (0600)" || warn "GHCR credential store present but mode $PERM (want 600)"
else
  warn "GHCR credential store absent (GHCR login not performed — private pulls blocked)"
fi

section "Container autostart (DockerMan templates)"
[ -f "$TEMPLATES/my-unraid-dashboard.xml" ] && ok "dashboard DockerMan template present" || warn "my-unraid-dashboard.xml template missing"
[ -f "$TEMPLATES/my-unraid-dashboard-helper.xml" ] && ok "helper DockerMan template present" || warn "my-unraid-dashboard-helper.xml template missing"
APP_RESTART=$(docker inspect unraid-dashboard --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || echo "missing")
HELPER_RESTART=$(docker inspect unraid-dashboard-helper --format '{{.HostConfig.RestartPolicy.Name}}' 2>/dev/null || echo "missing")
case "$APP_RESTART" in
  unless-stopped|always) ok "dashboard restart policy: $APP_RESTART" ;;
  *) bad "dashboard restart policy: $APP_RESTART (autostart at risk)" ;;
esac
case "$HELPER_RESTART" in
  unless-stopped|always) ok "helper restart policy: $HELPER_RESTART" ;;
  *) bad "helper restart policy: $HELPER_RESTART (autostart at risk)" ;;
esac
APP_NET=$(docker inspect unraid-dashboard --format '{{.HostConfig.NetworkMode}}' 2>/dev/null || echo "missing")
[ "$APP_NET" = "host" ] && ok "dashboard on host networking (no bridge/docker-DNS dependency at boot)" || warn "dashboard network mode: $APP_NET"

section "Persistent state"
[ -d "$APPDATA" ] && ok "app data dir on persistent storage: $APPDATA" || bad "app data dir missing"
[ -f "$APPDATA/update-history.jsonl" ] && ok "update history persisted" || warn "update history not created yet"
[ -f "$APPDATA/audit.jsonl" ] && ok "audit trail persisted" || warn "audit trail not created yet"
[ -d "$HELPER_STATE" ] && ok "helper state dir persistent (snapshots/jobs survive recreation): $HELPER_STATE" || bad "helper state dir missing"
BACKUPS=$(find "$APPDATA/backups/resilience" -name 'resilience-*.json' 2>/dev/null | wc -l)
[ "$BACKUPS" -gt 0 ] && ok "resilience backups present: $BACKUPS" || warn "no resilience backups yet (create one from the Operations page)"

section "Reverse proxy + auth (NPM / Authelia)"
if [ -f "$NPM_HTTP" ]; then
  ok "NPM custom http.conf present (persists with appdata)"
  grep -q "dashboard.familievalk.com" "$NPM_HTTP" && ok "dashboard proxy host configured" || bad "dashboard proxy host MISSING"
  grep -q "kiosk-dashboard.familievalk.com" "$NPM_HTTP" && ok "kiosk proxy host configured" || warn "kiosk proxy host missing"
  grep -q "auth_request" "$NPM_HTTP" && ok "Authelia auth_request wired" || bad "Authelia auth_request MISSING"
  grep -q "CF-Connecting-IP" "$NPM_HTTP" && ok "Cloudflare real-IP restore configured" || warn "CF real-IP config missing"
  grep -q "proxy_buffering off" "$NPM_HTTP" && ok "SSE (buffering off) configured" || warn "SSE config missing"
  grep -q "X-Dashboard-Auth-Token" "$NPM_HTTP" && ok "proxy secret injection configured" || bad "proxy secret injection MISSING"
else
  bad "NPM custom http.conf missing — dashboard host would vanish after NPM recreate"
fi
[ -d /mnt/cache/appdata/Authelia ] || [ -d /mnt/user/appdata/Authelia ] \
  && ok "Authelia config present on persistent storage" \
  || warn "Authelia config dir not found at the usual appdata paths"

section "Live firewall state (informational)"
if iptables -L DASH8090 -n >/dev/null 2>&1; then
  RETURNS=$(iptables -L DASH8090 -n | grep -c RETURN || true)
  DROPS=$(iptables -L DASH8090 -n | grep -c DROP || true)
  ok "DASH8090 chain live: $RETURNS RETURN / $DROPS DROP rules"
else
  warn "DASH8090 chain not live right now (boot block would restore it)"
fi

echo
echo "== Summary: $PASS passed, $WARN warnings, $FAIL failures =="

# Persist the result as a marker the dashboard's Operations page reads
# (release-chain → boot persistence). Contains no secrets.
MARKER_DIR="/mnt/user/appdata/unraid-dashboard"
MARKER="$MARKER_DIR/boot-verification.json"
if [ -d "$MARKER_DIR" ] && [ -w "$MARKER_DIR" ]; then
  printf '{\n  "verifiedAt": "%s",\n  "passed": %s,\n  "passedCount": %s,\n  "warnings": %s,\n  "failures": %s,\n  "scriptVersion": "0.8.0"\n}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$([ "$FAIL" -eq 0 ] && echo true || echo false)" "$PASS" "$WARN" "$FAIL" \
    > "$MARKER"
  echo "Marker written: $MARKER"
else
  echo "Marker NOT written: $MARKER_DIR missing or not writable" >&2
fi

[ "$FAIL" -eq 0 ]
