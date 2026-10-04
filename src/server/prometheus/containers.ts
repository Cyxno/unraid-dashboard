import {
  CONTAINER_CPU_QUERY,
  CONTAINER_MEMORY_LIMIT_QUERY,
  CONTAINER_MEMORY_USED_QUERY,
  HOST_MEM_TOTAL_CACHE_KEY,
  MEMORY_TOTAL_QUERY,
} from "./queries";
import { getPromClient, PromClient, withCache } from "./client";
import {
  CONTAINER_HIGH_CPU_PERCENT,
  CONTAINER_HIGH_MEMORY_BYTES,
  CONTAINER_HIGH_MEMORY_PERCENT_OF_LIMIT,
  MEMORY_LIMIT_HOST_TOLERANCE_BYTES,
} from "@/server/thresholds";
import type {
  ContainerMetrics,
  HistoryPoint,
  TopConsumers,
} from "@/lib/api-types";

/**
 * Per-container runtime metrics from cAdvisor (via Prometheus), selected
 * by cgroup id and joined on the container `name` label. CPU is
 * rate()-averaged over a window in Docker-style per-core percent
 * (1 fully-used core = 100%; >100% is valid) — the same semantics as the
 * retired docker_stats gauge, minus its ~instant snapshot behaviour.
 */

/** Escapes a container name for an exact-match PromQL string literal. */
export function promqlString(value: string): string {
  return JSON.stringify(value);
}

function byName(
  samples: Array<{ metric: Record<string, string>; v: number | null }>,
): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const sample of samples) {
    const name = sample.metric.name;
    if (typeof name === "string" && name.length > 0) {
      map.set(name, sample.v);
    }
  }
  return map;
}

/** Host total RAM — used to detect "no limit" containers. Cached 60s. */
export async function getHostMemoryTotal(
  client: PromClient,
): Promise<number | null> {
  return withCache(HOST_MEM_TOTAL_CACHE_KEY, 60_000, async () => {
    const samples = await client.instant(MEMORY_TOTAL_QUERY);
    return samples[0]?.v ?? null;
  });
}

/**
 * Container metric rows for all containers. Missing metrics (e.g. cAdvisor
 * has not seen a container yet) yield nulls — never zeros.
 */
export async function getContainerMetrics(
  client: PromClient,
): Promise<Map<string, ContainerMetrics>> {
  return withCache("containers:instant", 3_000, async () => {
    const [cpu, memUsed, memLimit, hostTotal] = await Promise.all([
      client.instant(CONTAINER_CPU_QUERY()),
      client.instant(CONTAINER_MEMORY_USED_QUERY()),
      client.instant(CONTAINER_MEMORY_LIMIT_QUERY()),
      getHostMemoryTotal(client),
    ]);

    const cpuMap = byName(cpu);
    const usedMap = byName(memUsed);
    const limitMap = byName(memLimit);

    const names = new Set<string>([
      ...cpuMap.keys(),
      ...usedMap.keys(),
      ...limitMap.keys(),
    ]);

    const result = new Map<string, ContainerMetrics>();
    for (const name of names) {
      const rawLimit = limitMap.get(name) ?? null;
      // cgroup-v2 unlimited containers report limit 0 — docker showed the
      // host RAM there. Treat anything non-positive as "no limit".
      const limit = rawLimit !== null && rawLimit > 0 ? rawLimit : null;
      const used = usedMap.get(name) ?? null;
      const hasLimit =
        limit !== null &&
        hostTotal !== null &&
        Math.abs(limit - hostTotal) > MEMORY_LIMIT_HOST_TOLERANCE_BYTES;
      const percentDenominator = limit ?? hostTotal;
      result.set(name, {
        cpuPercent: cpuMap.get(name) ?? null,
        memoryUsedBytes: used,
        memoryLimitBytes: limit,
        memoryPercentOfLimit:
          hasLimit && limit !== null && limit > 0
            ? ((used ?? 0) / limit) * 100
            : null,
        hasMemoryLimit: hasLimit,
        memoryPercentOfHost:
          used !== null && percentDenominator !== null && percentDenominator > 0
            ? (used / percentDenominator) * 100
            : null,
        networkRxBytesPerSec: null,
        networkTxBytesPerSec: null,
        networkReliable: false,
      });
    }
    return result;
  });
}

/**
 * Top consumers (running containers only — the freshness guard drops
 * recently destroyed containers, so stopped ones are naturally absent).
 */
export async function getTopConsumers(
  client: PromClient,
  limit = 5,
): Promise<TopConsumers> {
  return withCache(`containers:top:${limit}`, 5_000, async () => {
    const [cpu, used] = await Promise.all([
      client.instant(CONTAINER_CPU_QUERY()),
      client.instant(CONTAINER_MEMORY_USED_QUERY()),
    ]);
    const top = (
      samples: Array<{ metric: Record<string, string>; v: number | null }>,
      key: "percent" | "bytes",
    ) =>
      samples
        .filter((sample) => sample.v !== null)
        .sort((a, b) => (b.v ?? 0) - (a.v ?? 0))
        .slice(0, limit)
        .map((sample) => ({
          name: sample.metric.name ?? "?",
          percent: key === "percent" ? sample.v : null,
          bytes: key === "bytes" ? sample.v : null,
        }));
    return {
      meta: { source: "prometheus", status: "live", sampledAt: new Date().toISOString() },
      cpu: top(cpu, "percent") as TopConsumers["cpu"],
      memory: top(used, "bytes") as TopConsumers["memory"],
    };
  });
}

export interface ContainerHistory {
  cpu: HistoryPoint[];
  memoryBytes: HistoryPoint[];
}

/** Range history for one container by exact name. */
export async function getContainerHistory(
  client: PromClient,
  name: string,
  queries: { cpu: string; memory: string },
  startSeconds: number,
  endSeconds: number,
  stepSeconds: number,
): Promise<ContainerHistory> {
  const [cpuMatrix, memMatrix] = await Promise.all([
    client.range(queries.cpu, startSeconds, endSeconds, stepSeconds),
    client.range(queries.memory, startSeconds, endSeconds, stepSeconds),
  ]);
  const first = (
    matrix: Awaited<ReturnType<PromClient["range"]>>,
  ): HistoryPoint[] =>
    (matrix[0]?.points ?? []).map((point) => ({
      t: point.t * 1000,
      v: point.v,
    }));
  return {
    cpu: first(cpuMatrix),
    memoryBytes: first(memMatrix),
  };
}

/** True when a container passes the "high CPU" observation threshold. */
export function isHighCpu(metrics: ContainerMetrics | undefined): boolean {
  return (metrics?.cpuPercent ?? 0) >= CONTAINER_HIGH_CPU_PERCENT;
}

/**
 * True when a container passes the "high memory" observation: over the
 * absolute byte threshold, or over the %-of-limit threshold when a real
 * (non-host) limit exists.
 */
export function isHighMemory(
  metrics: ContainerMetrics | undefined | null,
): boolean {
  if (!metrics) return false;
  const { memoryUsedBytes, memoryPercentOfLimit, hasMemoryLimit } = metrics;
  if (hasMemoryLimit && memoryPercentOfLimit !== null) {
    if (memoryPercentOfLimit >= CONTAINER_HIGH_MEMORY_PERCENT_OF_LIMIT) {
      return true;
    }
  }
  return memoryUsedBytes !== null && memoryUsedBytes >= CONTAINER_HIGH_MEMORY_BYTES;
}

/* v0.4: per-container network throughput ----------------------------------- */

/**
 * cAdvisor reports network from each container's netns. For containers on
 * docker bridges that is the container's own eth0 — reliable. For
 * host-networked containers the netns is the host's, so every host
 * interface (br-*, veth*, eth0, …) is attributed to the container —
 * unreliable and double-counted at interface level.
 *
 * Detection rule: if a container reports ANY series on a host-only
 * interface pattern (br-*, br0, br1, docker0, veth*, shim-*, tunl0, lo), its
 * network numbers are marked unreliable and excluded; everything else is
 * summed across its eth* interfaces.
 */

const HOST_IFACE_PATTERN = /^(br-|br[0-9]+$|docker0|veth|shim-|tunl0|lo$)/;

export interface ContainerNetworkRate {
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  reliable: boolean;
}

export async function getContainerNetworkThroughput(): Promise<Map<string, ContainerNetworkRate>> {
  const client = getPromClient();
  return withCache("containers:network", 5_000, async () => {
    const rx = await client.instant(
      'sum by (name, interface) (rate(container_network_receive_bytes_total{name!=""}[2m]))',
    );
    const tx = await client.instant(
      'sum by (name, interface) (rate(container_network_transmit_bytes_total{name!=""}[2m]))',
    );

    interface Row {
      name: string;
      iface: string;
      v: number | null;
    }
    const rows = (samples: typeof rx): Row[] =>
      samples
        .map((sample) => ({
          name: sample.metric.name ?? "",
          iface: sample.metric.interface ?? "",
          v: sample.v,
        }))
        .filter((row) => row.name.length > 0 && row.iface.length > 0);

    const rxRows = rows(rx);
    const txRows = rows(tx);
    const names = new Set<string>([...rxRows, ...txRows].map((row) => row.name));

    const result = new Map<string, ContainerNetworkRate>();
    for (const name of names) {
      const ownRx = rxRows.filter((row) => row.name === name);
      const ownTx = txRows.filter((row) => row.name === name);
      const seesHostIfaces =
        ownRx.some((row) => HOST_IFACE_PATTERN.test(row.iface)) ||
        ownTx.some((row) => HOST_IFACE_PATTERN.test(row.iface));
      if (seesHostIfaces) {
        result.set(name, { rxBytesPerSec: null, txBytesPerSec: null, reliable: false });
        continue;
      }
      const sum = (list: Row[]) =>
        list.reduce<number>((total, row) => total + (row.v ?? 0), 0);
      result.set(name, {
        rxBytesPerSec: sum(ownRx),
        txBytesPerSec: sum(ownTx),
        reliable: true,
      });
    }
    return result;
  });
}

/** Per-container network rate history over a range (reliable containers only). */
export async function getContainerNetworkHistory(
  clientName: string,
  startSeconds: number,
  endSeconds: number,
  stepSeconds: number,
  rateWindow: string,
): Promise<{ rx: HistoryPoint[]; tx: HistoryPoint[] } | null> {
  const client = getPromClient();
  const escaped = promqlString(clientName);
  const rxQuery = `sum by (name) (rate(container_network_receive_bytes_total{name=${escaped},interface=~"eth[0-9]*"}[${rateWindow}]))`;
  const txQuery = `sum by (name) (rate(container_network_transmit_bytes_total{name=${escaped},interface=~"eth[0-9]*"}[${rateWindow}]))`;
  // Host-netns check: any host-pattern interface on this container → unreliable.
  const anyHostIface = await client.instant(
    `count by (name) (container_network_receive_bytes_total{name=${escaped},interface=~"${HOST_IFACE_PATTERN.source}"})`,
  ).catch(() => []);
  if (anyHostIface.length > 0) return null;

  const [rxMatrix, txMatrix] = await Promise.all([
    client.range(rxQuery, startSeconds, endSeconds, stepSeconds),
    client.range(txQuery, startSeconds, endSeconds, stepSeconds),
  ]);
  const collapse = (matrix: Awaited<ReturnType<PromClient["range"]>>): HistoryPoint[] =>
    matrix.flatMap((entry) => entry.points).sort((a, b) => a.t - b.t)
      .map((point) => ({ t: point.t * 1000, v: point.v }));
  return { rx: collapse(rxMatrix), tx: collapse(txMatrix) };
}
