/**
 * PromQL used by the dashboard. Every query here was verified against
 * a live Prometheus (job names, label names and metric names checked
 * via /api/v1/label/__name__ and test queries) — do not "fix" a
 * selector without re-verifying. The browser never supplies PromQL;
 * routes only pass validated windows/names into these builders.
 *
 * Expected sources:
 * - job="node"      node-exporter + textfile collector
 * - job="homelab"   host exporter (temperatures, power)
 * - job="cadvisor"  cAdvisor — container CPU/memory/network.
 *                     Containers are selected by cgroup id (the helper
 *                     inventory's Docker id is the /docker/<64hex> prefix),
 *                     not by the optional `name` label.
 */

/** Rate window placeholder replaced per request (never user input). */
function rate(window: string): string {
  return `[${window}]`;
}

/* System ------------------------------------------------------------------ */

export const CPU_TOTAL_QUERY = (rateWindow: string) =>
  `100 * (1 - avg(rate(node_cpu_seconds_total{mode="idle"}${rate(rateWindow)})))`;

export const CPU_PER_CORE_QUERY = (rateWindow: string) =>
  `100 * (1 - avg by (cpu) (rate(node_cpu_seconds_total{mode="idle"}${rate(rateWindow)})))`;

export const LOAD1_QUERY = "node_load1";
export const LOAD5_QUERY = "node_load5";
export const LOAD15_QUERY = "node_load15";

export const MEMORY_USED_QUERY =
  "node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes";
export const MEMORY_AVAILABLE_QUERY = "node_memory_MemAvailable_bytes";
export const MEMORY_TOTAL_QUERY = "node_memory_MemTotal_bytes";
export const MEMORY_CACHED_QUERY =
  "node_memory_Cached_bytes + node_memory_SReclaimable_bytes";
export const MEMORY_BUFFERS_QUERY = "node_memory_Buffers_bytes";
export const SWAP_USED_QUERY =
  "node_memory_SwapTotal_bytes - node_memory_SwapFree_bytes";
export const SWAP_TOTAL_QUERY = "node_memory_SwapTotal_bytes";

export const UPTIME_SECONDS_QUERY =
  "time() - node_boot_time_seconds";

export const CPU_THREADS_QUERY = "count(count by (cpu) (node_cpu_seconds_total))";

/* Thermal (homelab-exporter primary, node-exporter fallback) --------------- */

export const TEMPERATURES_QUERY = "homelab_temperature_celsius";
export const TEMPERATURE_RANGE_WINDOW = (window: string) =>
  `max_over_time(homelab_temperature_celsius[${window}])`;
export const PACKAGE_TEMP_FALLBACK_QUERY =
  'node_thermal_zone_temp{type="x86_pkg_temp"}';

export const POWER_WATTS_QUERY = 'homelab_power_watts{zone="psys"}';

/* Network ------------------------------------------------------------------
 * Physical-ish interfaces only: Unraid bridges br0/br1 carry the NIC
 * traffic (eth0 is the enslaved physical port). Docker bridges (br-*),
 * veths, docker0, shim-*, virbr*, wlan*, lo and tunl0 are excluded to
 * avoid double counting. Anchored so br-<hash> never matches br0/br1.
 */

export const PHYSICAL_IFACE_FILTER = "^(eth[0-9]+|br[0-9]+|tailscale[0-9]+)$";

export const IFACE_RX_QUERY = (rateWindow: string) =>
  `rate(node_network_receive_bytes_total{device=~"${PHYSICAL_IFACE_FILTER}"}${rate(rateWindow)})`;
export const IFACE_TX_QUERY = (rateWindow: string) =>
  `rate(node_network_transmit_bytes_total{device=~"${PHYSICAL_IFACE_FILTER}"}${rate(rateWindow)})`;
export const IFACE_RX_TOTAL_QUERY =
  `node_network_receive_bytes_total{device=~"${PHYSICAL_IFACE_FILTER}"}`;
export const IFACE_TX_TOTAL_QUERY =
  `node_network_transmit_bytes_total{device=~"${PHYSICAL_IFACE_FILTER}"}`;
export const IFACE_INFO_QUERY = `node_network_info{device=~"${PHYSICAL_IFACE_FILTER}"}`;
export const IFACE_SPEED_QUERY = `node_network_speed_bytes{device=~"${PHYSICAL_IFACE_FILTER}"}`;
export const IFACE_UP_QUERY = `node_network_up{device=~"${PHYSICAL_IFACE_FILTER}"}`;

/* Storage ------------------------------------------------------------------
 * Physical devices only (sdX/nvme): md* (array layer) and loop* devices
 * re-report the same I/O and would double-count.
 */

export const DISK_DEVICE_FILTER = "^(sd[a-z]+|nvme[0-9]+n[0-9]+|vd[a-z]+)$";

export const DISK_READ_QUERY = (rateWindow: string) =>
  `rate(node_disk_read_bytes_total{device=~"${DISK_DEVICE_FILTER}"}${rate(rateWindow)})`;
export const DISK_WRITTEN_QUERY = (rateWindow: string) =>
  `rate(node_disk_written_bytes_total{device=~"${DISK_DEVICE_FILTER}"}${rate(rateWindow)})`;
export const DISK_READ_IOPS_QUERY = (rateWindow: string) =>
  `rate(node_disk_reads_completed_total{device=~"${DISK_DEVICE_FILTER}"}${rate(rateWindow)})`;
export const DISK_WRITE_IOPS_QUERY = (rateWindow: string) =>
  `rate(node_disk_writes_completed_total{device=~"${DISK_DEVICE_FILTER}"}${rate(rateWindow)})`;

export const FILESYSTEM_USAGE_QUERY =
  'max by (mountpoint) (node_filesystem_size_bytes{fstype!~"tmpfs|squashfs|nsfs|overlay|rootfs"})';
export const FILESYSTEM_AVAIL_QUERY =
  'max by (mountpoint) (node_filesystem_avail_bytes{fstype!~"tmpfs|squashfs|nsfs|overlay|rootfs"})';

/* Containers (cAdvisor, id-joined) ------------------------------------------
 * Semantics matched to the retired docker_stats_* gauges (verified on
 * production 2026-10-04 with controlled --cpus=0.5/1/2 load tests and a
 * 60-minute parallel comparison, median ratio OLD/A = 1.29):
 * - CPU: docker stats CPUPerc = Docker-style PER-CORE percentage —
 *   1 fully-used core = 100%, 2 cores = 200%, 0.5 core = 50%.
 *   Derivation: docker's (cpuDelta/systemDelta) × onlineCPUs × 100 with
 *   systemDelta = total host CPU-seconds (all cores, idle included) gives
 *   (c·W / 16·W) × 16 × 100 = c × 100. The cAdvisor counter rate is in
 *   cores, so the equivalent is rate(...) × 100 — NO division by
 *   machine_cpu_cores (that was v1.3.6's factor-16 regression, fixed in
 *   v1.3.7). Values above 100% are valid and must not be clamped.
 *   Averaged over CONTAINER_CPU_RATE_WINDOW (the old gauge was an ~instant
 *   snapshot; values now move smoother — documented in the changelog).
 * - Memory used: container_memory_working_set_bytes equals docker's
 *   "MEM USAGE" (usage − inactive_file); shadow median Δ 0.02%.
 * - Memory limit: container_spec_memory_limit_bytes is 0 on cgroup-v2
 *   unlimited containers (docker showed host RAM instead) — the caller
 *   treats limit ≤ 0 as "no limit".
 * - Freshness: cAdvisor keeps series of DESTROYED containers for minutes
 *   (verified: 4 ghosts). container_last_seen freezes at destruction, so
 *   the unless-guard drops only ids that demonstrably went stale; ids
 *   without a last_seen series survive (resilient fallback).
 */

/** cgroup selector: real Docker containers only — excludes cAdvisor's
 *  /docker/buildkit, /docker/buildx and host slices. */
export const CADVISOR_DOCKER_SELECTOR = 'id=~"/docker/[0-9a-f]{64}"';

/** Destruction-freshness guard: drop ids whose last_seen froze >90s ago
 *  (6 scrape intervals). `unless` (not `and`) so series without any
 *  last_seen sample are kept. */
export function cadvisorFreshnessGuard(): string {
  return `unless on (id) (container_last_seen{${CADVISOR_DOCKER_SELECTOR}} < (time() - 90))`;
}

/** Average window for container CPU percent (rate lookback). */
export const CONTAINER_CPU_RATE_WINDOW = "2m";

/** Container CPU in Docker-style per-core percent: 1 core = 100%. */
export const CONTAINER_CPU_QUERY = (rateWindow: string = CONTAINER_CPU_RATE_WINDOW) =>
  `100 * sum by (name) (rate(container_cpu_usage_seconds_total{${CADVISOR_DOCKER_SELECTOR}}[${rateWindow}]) ${cadvisorFreshnessGuard()})`;

export const CONTAINER_MEMORY_USED_QUERY = () =>
  `container_memory_working_set_bytes{${CADVISOR_DOCKER_SELECTOR}} ${cadvisorFreshnessGuard()}`;
export const CONTAINER_MEMORY_LIMIT_QUERY = () =>
  `container_spec_memory_limit_bytes{${CADVISOR_DOCKER_SELECTOR}} ${cadvisorFreshnessGuard()}`;

/**
 * Id-anchored per-container builders (helper inventory id, 12+ hex chars —
 * validated by dockerIdPattern before use). Preferred over the name-based
 * fallbacks: a recreated container keeps its name but gets a new id, so
 * id-anchored history never blends two containers.
 */
export function containerCpuQuery(idOrName: string, rateWindow: string = CONTAINER_CPU_RATE_WINDOW): string {
  if (/^[0-9a-f]{12,64}$/.test(idOrName)) {
    return `100 * sum (rate(container_cpu_usage_seconds_total{id=~"/docker/${idOrName}[0-9a-f]*"}[${rateWindow}]))`;
  }
  return `100 * sum (rate(container_cpu_usage_seconds_total{name=${JSON.stringify(idOrName)}}[${rateWindow}]))`;
}

export function containerMemoryUsedQuery(idOrName: string): string {
  if (/^[0-9a-f]{12,64}$/.test(idOrName)) {
    return `container_memory_working_set_bytes{id=~"/docker/${idOrName}[0-9a-f]*"}`;
  }
  return `container_memory_working_set_bytes{name=${JSON.stringify(idOrName)}}`;
}

/* Host totals used for limit heuristics ------------------------------------- */

export const HOST_MEM_TOTAL_CACHE_KEY = "host-mem-total";
