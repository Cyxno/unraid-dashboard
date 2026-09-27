# Disaster Recovery

Recovery procedures for the Unraid Dashboard. No secrets in this document.

## Recovery URLs

| Path | URL | Auth |
|---|---|---|
| HTTPS (primary) | `https://dashboard.familievalk.com` | Cloudflare → NPM → Authelia (2FA) |
| Kiosk (no auth) | `https://kiosk-dashboard.familievalk.com` | Network allowlist only |
| LAN direct | `http://192.168.1.2:8090` | trusted-local (hybrid auth) |
| Tailscale | `http://100.99.246.116:8090` | trusted-local (hybrid auth) |
| localhost | `http://127.0.0.1:8090` | trusted-local (hybrid auth) |

## Dashboard inaccessible

### 1. Check container state
```sh
docker ps -a --filter name=unraid-dashboard
docker logs --tail 20 unraid-dashboard
```

### 2. Restart container
```sh
docker restart unraid-dashboard
```

### 3. Roll back to previous image
```sh
sh scripts/update-dashboard.sh ghcr.io/cyxno/unraid-dashboard:0.7.11
```
Or manually with the `previous` tag:
```sh
docker tag unraid-dashboard:previous ghcr.io/cyxno/unraid-dashboard:manual-rollback
sh scripts/update-dashboard.sh ghcr.io/cyxno/unraid-dashboard:manual-rollback
```

### 4. Manual recreate (last resort)
```sh
docker rm -f unraid-dashboard
docker run -d --name unraid-dashboard --network host --restart unless-stopped \
  -v /mnt/user/appdata/unraid-dashboard:/app/data \
  -e PORT=8090 \
  -e UNRAID_URL=http://127.0.0.1:442 \
  -e UNRAID_API_KEY=<key-from-flash> \
  -e PROMETHEUS_URL=http://127.0.0.1:9090 \
  ghcr.io/cyxno/unraid-dashboard:<tag>
```
API key location: `/root/.unraid-dashboard-apikey` (or DockerMan template).

## Bad dashboard update

The update machine rolls back automatically. If it failed:
```sh
# Check what happened
docker exec unraid-dashboard-helper cat /helper-state/jobs.json
# Restore previous version manually
sh scripts/update-dashboard.sh ghcr.io/cyxno/unraid-dashboard:0.7.11
```

## Helper broken

```sh
# Disable the helper (dashboard remains read-only, no updates)
docker stop unraid-dashboard-helper && docker rm unraid-dashboard-helper
# Restore: redeploy
UPDATE_HELPER_TOKEN=$(openssl rand -hex 32) scripts/deploy-helper.sh
```

## `/app/data` corruption

```sh
# Check what's corrupt
ls -la /mnt/user/appdata/unraid-dashboard/
# Restore dashboards from latest backup
cp /mnt/user/appdata/unraid-dashboard/backups/resilience/resilience-*.json \
   /mnt/user/appdata/unraid-dashboard/backups/restored.json
# Verify and manually copy individual dashboards back
```

## Compose containers

```sh
cd /boot/config/plugins/compose.manager/projects/<Project>
docker compose up -d <service>
```

Or for user-appdata compose projects:

```sh
cd /mnt/user/appdata/<project-dir>
docker compose up -d
```

## Proxy/auth broken

```sh
# NPM config test
docker exec Nginx-Proxy-Manager-Official nginx -t
# Direct LAN access should still work (firewall allows LAN on 8090)
curl -s http://192.168.1.2:8090/api/health
# If Authelia is down, the kiosk path still works (network-only auth)
curl -sk --resolve kiosk-dashboard.familievalk.com:443:192.168.1.2 \
  https://kiosk-dashboard.familievalk.com/api/health
```

## GHCR unavailable

For remote pulls the host needs a persistent login: run
`scripts/login-ghcr.sh` with a `read:packages` PAT (one-time). Without
it local images are used and update detection reports `auth required`.

Local images persist. The update machine falls back to local images on
pull failure. No unnecessary recreation is triggered.

## Firewall (port 8090 isolation)

```sh
# View rules
iptables -L DASH8090 -n
# Disable (temporarily — restores on next reboot via /boot/config/go)
iptables -D INPUT -p tcp --dport 8090 -j DASH8090 2>/dev/null
iptables -F DASH8090 2>/dev/null
iptables -X DASH8090 2>/dev/null
```

## Status script

```sh
sh scripts/dashboard-status.sh
```
