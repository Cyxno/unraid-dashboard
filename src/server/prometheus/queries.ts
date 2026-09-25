/**
 * PromQL used by the dashboard. Every query here was verified against
 * the live Prometheus on this host (job names, label names and metric
 * names checked via /api/v1/label/__name__ and test queries) — do not
 * "fix" a selector without re-verifying. The browser never supplies
 * PromQL; routes only pass validated windows/names into these builders.
 *
 * Sources on this host:
 * - job="node"      node-exporter (192.168.1.2:9100) + textfile collector
 *                     (docker_stats_* gauges, refreshed every 15s)
 * - job="homelab"   homelab-exporter (temperatures, power)
 * - job="cadvisor"  cAdvisor — cgroup-id labels only (no name/image),
 *                     intentionally NOT used for name-keyed metrics
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

/* Containers (docker_stats textfile gauges, name-keyed) --------------------- */

export const CONTAINER_CPU_QUERY = 'docker_stats_cpu_percent';
export const CONTAINER_MEMORY_USED_QUERY = 'docker_stats_memory_usage_bytes';
export const CONTAINER_MEMORY_LIMIT_QUERY = 'docker_stats_memory_limit_bytes';
export const CONTAINER_MEMORY_PERCENT_QUERY = 'docker_stats_memory_percent';

export const CONTAINER_CPU_BY_NAME_QUERY = (name: string) =>
  `docker_stats_cpu_percent{name=${JSON.stringify(name)}}`;
export const CONTAINER_MEMORY_BY_NAME_QUERY = (name: string) =>
  `docker_stats_memory_usage_bytes{name=${JSON.stringify(name)}}`;

/* Host totals used for limit heuristics ------------------------------------- */

export const HOST_MEM_TOTAL_CACHE_KEY = "host-mem-total";
