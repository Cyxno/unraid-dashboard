import {
  DISK_READ_IOPS_QUERY,
  DISK_READ_QUERY,
  DISK_WRITTEN_QUERY,
  DISK_WRITE_IOPS_QUERY,
} from "./queries";
import { PromClient } from "./client";
import type {
  DiskIoSnapshot,
  HistoryPoint,
  NamedSeries,
} from "@/lib/api-types";

/**
 * Disk I/O from node-exporter, physical devices only (sdX/nvme/vdX).
 * The array layer (md*) reports the same bytes as its member disks, so
 * it is excluded; "totals" here are the sum across physical devices.
 * Mapping to Unraid disks happens in the storage service by matching
 * Unraid's per-disk `device` field (e.g. "sdd") to these series.
 */

interface DeviceSample {
  metric: Record<string, string>;
  v: number | null;
}

function byDevice(samples: DeviceSample[]): Map<string, number | null> {
  const map = new Map<string, number | null>();
  for (const sample of samples) {
    const device = sample.metric.device;
    if (typeof device === "string" && device.length > 0) {
      map.set(device, sample.v);
    }
  }
  return map;
}

function sumValues(map: Map<string, number | null>): number | null {
  let total = 0;
  let any = false;
  for (const value of map.values()) {
    if (value !== null) {
      total += value;
      any = true;
    }
  }
  return any ? total : null;
}

export async function getDiskIo(
  client: PromClient,
): Promise<DiskIoSnapshot> {
  const [readMap, writeMap, readIops, writeIops] = await Promise.all([
    client.instant(DISK_READ_QUERY("2m")),
    client.instant(DISK_WRITTEN_QUERY("2m")),
    client.instant(DISK_READ_IOPS_QUERY("2m")),
    client.instant(DISK_WRITE_IOPS_QUERY("2m")),
  ]);
  const read = byDevice(readMap);
  const write = byDevice(writeMap);
  const rIops = byDevice(readIops);
  const wIops = byDevice(writeIops);

  const devices = new Set<string>([
    ...read.keys(),
    ...write.keys(),
    ...rIops.keys(),
    ...wIops.keys(),
  ]);

  return {
    meta: { source: "prometheus", status: "live", sampledAt: new Date().toISOString() },
    devices: [...devices]
      .sort()
      .map((device) => ({
        device,
        readBytesPerSec: read.get(device) ?? null,
        writeBytesPerSec: write.get(device) ?? null,
        readIops: rIops.get(device) ?? null,
        writeIops: wIops.get(device) ?? null,
      })),
    totals: {
      readBytesPerSec: sumValues(read),
      writeBytesPerSec: sumValues(write),
    },
  };
}

export interface StorageHistoryResult {
  read: NamedSeries[];
  write: NamedSeries[];
  readIops: NamedSeries[];
  writeIops: NamedSeries[];
  totals: { read: HistoryPoint[]; write: HistoryPoint[] };
}

/**
 * Per-device + aggregate disk throughput/IOPS history. Per-device series
 * keep their device label; the aggregate is computed client-side of the
 * query by summing point-wise across devices.
 */
export async function getStorageHistory(
  client: PromClient,
  queries: { read: string; write: string; readIops: string; writeIops: string },
  startSeconds: number,
  endSeconds: number,
  stepSeconds: number,
): Promise<StorageHistoryResult> {
  const [readMatrix, writeMatrix, rIopsMatrix, wIopsMatrix] = await Promise.all([
    client.range(queries.read, startSeconds, endSeconds, stepSeconds),
    client.range(queries.write, startSeconds, endSeconds, stepSeconds),
    client.range(queries.readIops, startSeconds, endSeconds, stepSeconds),
    client.range(queries.writeIops, startSeconds, endSeconds, stepSeconds),
  ]);

  const toSeries = (
    matrix: Awaited<ReturnType<PromClient["range"]>>,
  ): NamedSeries[] =>
    matrix
      .map((entry) => ({
        name: entry.metric.device ?? "?",
        points: entry.points.map((point) => ({
          t: point.t * 1000,
          v: point.v,
        })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

  const sumMatrix = (matrix: Awaited<ReturnType<PromClient["range"]>>): HistoryPoint[] => {
    const perTime = new Map<number, number>();
    for (const entry of matrix) {
      for (const point of entry.points) {
        if (point.v !== null) {
          perTime.set(point.t, (perTime.get(point.t) ?? 0) + point.v);
        }
      }
    }
    return [...perTime.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, v]) => ({ t: t * 1000, v }));
  };

  return {
    read: toSeries(readMatrix),
    write: toSeries(writeMatrix),
    readIops: toSeries(rIopsMatrix),
    writeIops: toSeries(wIopsMatrix),
    totals: {
      read: sumMatrix(readMatrix),
      write: sumMatrix(writeMatrix),
    },
  };
}
