# Docker-stats textfile collector retirement

Status: **executed 2026-10-04 (v1.3.7, SHA 58e969b)** — Beacon no longer reads
the `docker_stats_*` gauges. The collector container was stopped + removed,
the `docker-stats.prom` output deleted and its autostart line removed; a
4-hour post-retirement soak (10:15–13:38 UTC) showed no regressions: container
CPU/memory serve from cAdvisor (id-joined), dockerd avg 6.21% → 5.85% of one
core, the collector's own ~3.6%-of-a-core cost is gone. Rollback: see
`/mnt/cache/appdata/docker-stats-textfile/retirement-backup-20261004/ROLLBACK.md`.

## What the collector is

The `docker-stats-textfile` container runs
`/mnt/cache/appdata/docker-stats-textfile/collect.sh`: every 15s it shells
out to `docker stats --no-stream`, converts the output and atomically writes
`/mnt/cache/appdata/node-exporter/textfile/docker-stats.prom`, which the
node-exporter textfile collector exposes as the `docker_stats_*` gauges.

It holds the **Docker socket** (`/var/run/docker.sock`) — a privileged
surface that existed purely to feed Beacon per-container CPU/memory numbers.
It also writes `dumb-processes.prom` (per-process RSS/PSS inside the DUMB
container); that part is independent of this migration — see "If you also
want to stop the DUMB collector" below.

## Why Beacon migrated

- cAdvisor already scrapes the same numbers with the same semantics
  (`container_memory_working_set_bytes` ≡ docker's "MEM USAGE", median
  Δ 0.02% in a live shadow comparison on this host).
- The id-join (helper inventory container id ↔ cAdvisor `id` label) is more
  precise than name-keyed series: a recreated container gets a new id and
  its history never blends with its predecessor's.
- Destroyed-container leftovers are filtered by a `container_last_seen`
  freshness guard, so top-consumers never lists ghosts.
- Removing a second Docker-socket consumer shrinks the attack surface.

## Verification checklist before switching off

1. v1.3.6 runs (`/api/version` reports 1.3.6) and `/api/overview` /
   Docker page shows plausible CPU% and memory for all running containers.
2. Docker page → container detail: history graphs (CPU + memory) are
   continuous across the deploy.
3. Settings → Thermal: episode attribution still lists top CPU containers.
4. Notifications still fire for high-CPU / high-memory observations
   (they read the same cAdvisor-backed maps).

## Switch-off procedure (operator)

```sh
# 1. Stop + remove the collector container (keeps the image for rollback)
docker stop docker-stats-textfile && docker rm docker-stats-textfile

# 2. Confirm Beacon still shows container metrics (they come from cAdvisor now)
#    and that the textfile series go stale:
#    docker_stats_cpu_percent disappears from Prometheus after ~5 min.

# 3. Optionally remove the leftover .prom file so the gauge is gone for good:
rm -f /mnt/cache/appdata/node-exporter/textfile/docker-stats.prom
```

Rollback: `docker run` the same image again with the same volume mappings
(the DockerMan template `docker-stats-textfile` documents them), or restore
from the inspect backup in
`/boot/config/plugins/dockerMan/templates-user/`.

## If you also want to stop the DUMB collector

`collect.sh` also emits `dumb_process_rss_bytes` / `dumb_process_pss_bytes`.
If any other dashboard or alert still reads those, keep a slimmed variant of
the script; otherwise the whole collector can go. Beacon reads neither.
