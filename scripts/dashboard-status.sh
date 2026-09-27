#!/bin/sh
# Read-only dashboard status — no secrets output.
# Usage: scripts/dashboard-status.sh
set -eu

SECRET="${AUTH_PROXY_SECRET:-}"
[ -z "$SECRET" ] && [ -f /boot/config/custom/dashboard/proxy-auth-secret ] && SECRET=$(cat /boot/config/custom/dashboard/proxy-auth-secret)

echo "=== Dashboard Status ==="
echo "-- app container:"
docker ps -a --filter name=unraid-dashboard --format '{{.Names}} {{.Image}} {{.Status}}'
echo "-- helper container:"
docker ps -a --filter name=unraid-dashboard-helper --format '{{.Names}} {{.Image}} {{.Status}}'
echo "-- version:"
curl -s -m 5 http://127.0.0.1:8090/api/version 2>/dev/null | head -c 120 || echo "(timeout)"
echo
echo "-- auth mode:"
curl -s -m 5 "http://127.0.0.1:8090/api/auth/status" 2>/dev/null | head -c 120 || echo "(unreachable)"
echo
echo "-- data volume:"
docker inspect unraid-dashboard --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' 2>/dev/null
echo "-- update history (recent):"
tail -3 /mnt/user/appdata/unraid-dashboard/update-history.jsonl 2>/dev/null | node -e "let d='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>d+=c).on('end',()=>{for(const l of d.trim().split('\n')){try{const u=JSON.parse(l);console.log('  '+u.fromVersion+'→'+u.toVersion+':'+u.result)}catch{}}})" 2>/dev/null || echo "  (onleesbaar)"
echo "-- rollback image:"
docker images --format '{{.Repository}}:{{.Tag}}' | grep "unraid-dashboard:previous" | head -1 || echo "(geen previous-tag)"
echo "-- firewall DASH8090:"
iptables -L DASH8090 -n 2>/dev/null | grep -c RETURN | xargs echo "  RETURN-regels:"
iptables -L DASH8090 -n 2>/dev/null | grep -c DROP | xargs echo "  DROP-regels:"
echo "-- compose roots in helper:"
docker exec unraid-dashboard-helper printenv COMPOSE_ALLOWED_ROOTS 2>/dev/null | tr ',' '\n' | head -8 || echo "  (helper onbereikbaar)"
echo "-- Unraid connectivity:"
curl -s -m 5 -o /dev/null -w "  %{http_code}\n" http://127.0.0.1:442/graphql 2>/dev/null || echo "  unreachable"
echo "-- Prometheus connectivity:"
curl -s -m 5 -o /dev/null -w "  %{http_code}\n" http://127.0.0.1:9090/-/healthy 2>/dev/null || echo "  unreachable"
echo "=== done ==="
