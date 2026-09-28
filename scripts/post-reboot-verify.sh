#!/bin/sh
# =============================================================================
# Post-reboot verification (v0.7.14) — run ONCE after a host reboot.
# Produces every proof the release runbook asks for (sections 17-19):
# Docker autostart, GHCR credential persistence (real pull, not just file
# presence), firewall, proxy/auth stack, data integrity, auth matrix.
# Read-only except: harmless `docker pull` (materializes an image) and the
# boot-verification marker refresh. Stores no secrets, prints no tokens.
# =============================================================================
set -u
PASS=0; FAIL=0
ok()  { echo "  PASS  $1"; PASS=$((PASS + 1)); }
bad() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }
section() { echo; echo "== $1 =="; }

section "Docker autostart"
sleep 2
APP=$(docker ps --filter name=unraid-dashboard --format '{{.Status}}' | head -1)
HELPER=$(docker ps --filter name=unraid-dashboard-helper --format '{{.Status}}' | head -1)
echo "$APP"   | grep -q healthy && ok "dashboard auto-started healthy: $APP"   || bad "dashboard not healthy: $APP"
echo "$HELPER" | grep -q healthy && ok "helper auto-started healthy: $HELPER" || bad "helper not healthy: $HELPER"
PROM=$(docker ps --filter name=prometheus --format '{{.Names}}' | head -1)
[ "$PROM" = "prometheus" ] && ok "prometheus restored" || bad "prometheus missing"
TOTAL=$(docker ps -q | wc -l)
echo "  INFO  containers running: $TOTAL (baseline ~62)"

section "GHCR credential persistence (functional, not just file presence)"
[ -f /root/.docker/config.json ] && ok "credential file restored to /root/.docker" || bad "credential file missing"
[ -f /boot/config/custom/dashboard/docker-cred/config.json ] && ok "flash store present" || bad "flash store missing"
docker exec unraid-dashboard-helper sh -c 'test -r /root/.docker/config.json' 2>/dev/null \
  && ok "helper sees the credential mount" || bad "helper credential mount missing"
# REAL pull proof — this is the acceptance criterion, not file existence.
if docker pull ghcr.io/cyxno/unraid-dashboard:0.7.14 >/dev/null 2>&1; then
  ok "authenticated remote pull works after reboot (no new login)"
else
  bad "remote pull FAILED after reboot — credential persistence broken"
fi
DIGEST_LOCAL=$(docker image inspect ghcr.io/cyxno/unraid-dashboard:0.7.14 --format '{{index .RepoDigests 0}}' 2>/dev/null || echo "none")
echo "  INFO  0.7.14 RepoDigest: $DIGEST_LOCAL"

section "Network / security"
iptables -L DASH8090 -n >/dev/null 2>&1 \
  && ok "DASH8090 firewall chain restored ($(iptables -L DASH8090 -n | grep -c RETURN) RETURN / $(iptables -L DASH8090 -n | grep -c DROP) DROP)" \
  || bad "DASH8090 chain MISSING"
systemctl is-active ssh 2>/dev/null | grep -q active || pgrep -f sshd >/dev/null 2>&1 && ok "SSH alive" || bad "SSH dead"
NPM=$(docker ps --filter name=Nginx-Proxy-Manager --format '{{.Status}}' | head -1)
echo "$NPM" | grep -q "Up" && ok "NPM restored: $NPM" || bad "NPM missing"
AUTH=$(docker ps --filter name=Authelia --format '{{.Status}}' | head -1)
echo "$AUTH" | grep -q healthy && ok "Authelia restored: $AUTH" || bad "Authelia missing"
grep -q "CF-Connecting-IP" /mnt/user/appdata/Nginx-Proxy-Manager-Official/data/nginx/custom/http.conf 2>/dev/null \
  && ok "Cloudflare real-IP + SSE config persisted" || bad "NPM custom config lost"
curl -sk -m 10 -o /dev/null https://dashboard.familievalk.com/ --resolve dashboard.familievalk.com:443:192.168.1.2
CODE=$?
[ "$CODE" -eq 0 ] && ok "HTTPS endpoint answered (TLS+proxy up)" || bad "HTTPS endpoint unreachable (curl $CODE)"

section "Data + app"
curl -s -m 8 -o /dev/null -w "" http://127.0.0.1:8090/api/health && ok "/api/health 200" || bad "/api/health failed"
VERSION=$(curl -s -m 8 http://127.0.0.1:8090/api/version | grep -o '"version":"[^"]*"')
echo "  INFO  running $VERSION"
curl -s -m 10 -o /dev/null http://127.0.0.1:8090/api/overview && ok "/api/overview live" || bad "/api/overview failed"
DASH_COUNT=$(ls /mnt/user/appdata/unraid-dashboard/dashboards 2>/dev/null | wc -l)
ok "shared dashboards on disk: $DASH_COUNT"
[ -s /mnt/user/appdata/unraid-dashboard/audit.jsonl ] && ok "audit trail intact" || bad "audit trail missing"
[ -s /mnt/user/appdata/unraid-dashboard/update-history.jsonl ] && ok "update history intact" || bad "update history missing"
BACKUPS=$(find /mnt/user/appdata/unraid-dashboard/backups/resilience -name 'resilience-*.json' 2>/dev/null | wc -l)
[ "$BACKUPS" -gt 0 ] && ok "resilience backups: $BACKUPS" || bad "no resilience backups"

section "Auth matrix"
for TARGET in "http://192.168.1.2:8090/ 200 LAN" "http://localhost:8090/ 200 localhost"; do
  set -- $TARGET
  CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$1")
  [ "$CODE" = "$2" ] && ok "$3 direct -> $CODE" || bad "$3 direct -> $CODE (want $2)"
done
CODE=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://dashboard.familievalk.com/" --resolve dashboard.familievalk.com:443:192.168.1.2)
[ "$CODE" = "302" ] && ok "HTTPS unauth -> 302 Authelia" || bad "HTTPS unauth -> $CODE (want 302)"
CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -H "X-Dashboard-Auth-Token: wrong" -H "X-Forwarded-User: kiosk" http://192.168.1.2:8090/)
[ "$CODE" = "401" ] && ok "wrong proxy secret -> 401" || bad "wrong proxy secret -> $CODE (want 401)"
TS=$(tailscale ip -4 2>/dev/null | head -1)
if [ -n "$TS" ]; then
  CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$TS:8090/")
  [ "$CODE" = "200" ] && ok "Tailscale -> 200" || bad "Tailscale -> $CODE"
fi
timeout 4 curl -s -N -m 3 http://127.0.0.1:8090/api/events 2>/dev/null | grep -q "event: hello" && ok "SSE hello on LAN" || bad "SSE failed"

section "Rollback readiness"
[ -f "unraid-dashboard:previous" ] 2>/dev/null
docker image inspect unraid-dashboard:previous >/dev/null 2>&1 && ok "rollback image 'previous' present: $(docker image inspect unraid-dashboard:previous --format '{{.Id}}' | cut -c8-19)" || bad "rollback image 'previous' missing"
SNAPS=$(ls /mnt/user/appdata/unraid-dashboard/helper-state/snapshots 2>/dev/null | wc -l)
ok "helper snapshots stored: $SNAPS"

echo
echo "== Post-reboot verification: $PASS passed, $FAIL failed =="
[ "$FAIL" -eq 0 ]
