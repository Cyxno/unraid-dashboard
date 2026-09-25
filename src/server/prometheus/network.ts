import {
  IFACE_INFO_QUERY,
  IFACE_RX_QUERY,
  IFACE_RX_TOTAL_QUERY,
  IFACE_SPEED_QUERY,
  IFACE_TX_QUERY,
  IFACE_TX_TOTAL_QUERY,
  IFACE_UP_QUERY,
} from "./queries";
import { PromClient, withCache } from "./client";
import type {
  HistoryPoint,
  InterfaceHistoryPayload,
} from "@/lib/api-types";

/**
 * Per-interface network metrics from node-exporter, restricted to the
 * physical-ish set (eth*, br0/br1, tailscale*) — docker bridges and veths
 * mirror the same bytes and would double-count. eth0 is enslaved to br0
 * on this host, so the aggregate/primary interface is the device with the
 * highest (rx+tx) that is NOT a bridge duplicate: in practice eth0.
 */

export interface InterfaceInstant {
  device: string;
  rxBytesPerSec: number | null;
  txBytesPerSec: number | null;
  totalReceivedBytes: number | null;
  totalSentBytes: number | null;
  speedBytesPerSec: number | null;
  operstate: string | null;
  up: boolean | null;
}

function label(
  metric: Record<string, string> | undefined,
  key: string,
): string | null {
  const value = metric?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}


export async function getInterfacesInstant(
  client: PromClient,
): Promise<InterfaceInstant[]> {
  return withCache("network:instant", 2_000, async () => {
    const [rx, tx, rxTotal, txTotal, speed, info, up] = await Promise.all([
      client.instant(IFACE_RX_QUERY("2m")),
      client.instant(IFACE_TX_QUERY("2m")),
      client.instant(IFACE_RX_TOTAL_QUERY),
      client.instant(IFACE_TX_TOTAL_QUERY),
      client.instant(IFACE_SPEED_QUERY).catch(() => []),
      client.instant(IFACE_INFO_QUERY),
      client.instant(IFACE_UP_QUERY).catch(() => []),
    ]);

    const byDevice = (
      samples: Array<{ metric: Record<string, string>; v: number | null }>,
    ) => {
      const map = new Map<string, number | null>();
      for (const sample of samples) {
        const device = label(sample.metric, "device");
        if (device) map.set(device, sample.v);
      }
      return map;
    };

    const rxMap = byDevice(rx);
    const txMap = byDevice(tx);
    const rxTotalMap = byDevice(rxTotal);
    const txTotalMap = byDevice(txTotal);
    const speedMap = byDevice(speed);
    const upMap = byDevice(up);
    const operstateMap = new Map(
      info
        .map((sample) => [
          label(sample.metric, "device"),
          label(sample.metric, "operstate"),
        ])
        .filter((entry): entry is [string, string] => entry[0] !== null),
    );

    const devices = new Set<string>([
      ...rxMap.keys(),
      ...txMap.keys(),
      ...rxTotalMap.keys(),
      ...txTotalMap.keys(),
    ]);

    return [...devices]
      .map((device) => ({
        device,
        rxBytesPerSec: rxMap.get(device) ?? null,
        txBytesPerSec: txMap.get(device) ?? null,
        totalReceivedBytes: rxTotalMap.get(device) ?? null,
        totalSentBytes: txTotalMap.get(device) ?? null,
        speedBytesPerSec: speedMap.get(device) ?? null,
        operstate: operstateMap.get(device) ?? null,
        up: upMap.has(device) ? (upMap.get(device) === 1) : null,
      }))
      .sort((a, b) => {
        // eth0 first (primary), then bridges, then the rest.
        const rank = (device: string) =>
          device === "eth0" ? 0 : /^br[0-9]+$/.test(device) ? 1 : 2;
        return (
          rank(a.device) - rank(b.device) || a.device.localeCompare(b.device)
        );
      });
  });
}

/**
 * The "primary" interface for Overview RX/TX: highest throughput among
 * non-bridge devices, falling back to the busiest overall. Deterministic
 * rule, documented — never silently summed across bridges.
 */
export function pickPrimaryInterface(
  interfaces: InterfaceInstant[],
): InterfaceInstant | null {
  if (interfaces.length === 0) return null;
  const total = (iface: InterfaceInstant) =>
    (iface.rxBytesPerSec ?? 0) + (iface.txBytesPerSec ?? 0);
  const physical = interfaces.filter((iface) => iface.device.startsWith("eth"));
  const pool = physical.length > 0 ? physical : interfaces;
  return pool.reduce((best, iface) => (total(iface) > total(best) ? iface : best));
}

export async function getInterfacesHistory(
  client: PromClient,
  rxQuery: string,
  txQuery: string,
  startSeconds: number,
  endSeconds: number,
  stepSeconds: number,
): Promise<InterfaceHistoryPayload["interfaces"]> {
  const [rxMatrix, txMatrix] = await Promise.all([
    client.range(rxQuery, startSeconds, endSeconds, stepSeconds),
    client.range(txQuery, startSeconds, endSeconds, stepSeconds),
  ]);
  const toPoints = (
    matrix: Awaited<ReturnType<PromClient["range"]>>,
  ): Map<string, HistoryPoint[]> => {
    const map = new Map<string, HistoryPoint[]>();
    for (const entry of matrix) {
      const device = label(entry.metric, "device") ?? "?";
      map.set(
        device,
        entry.points.map((point) => ({ t: point.t * 1000, v: point.v })),
      );
    }
    return map;
  };
  const rxPoints = toPoints(rxMatrix);
  const txPoints = toPoints(txMatrix);
  const devices = new Set<string>([...rxPoints.keys(), ...txPoints.keys()]);
  return [...devices]
    .map((device) => ({
      name: device,
      rxPoints: rxPoints.get(device) ?? [],
      txPoints: txPoints.get(device) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
