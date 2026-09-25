import { getUnraidClient, UnraidApiError } from "./client";
import {
  ARRAY_QUERY,
  DOCKER_QUERY,
  METRICS_QUERY,
  NOTIFICATIONS_QUERY,
  SERVER_IDENTITY_QUERY,
} from "./queries";
import {
  mapCpu,
  mapDocker,
  mapIdentity,
  mapMemory,
  mapNetwork,
  mapNotifications,
  mapStorage,
} from "./mappers";
import { mockOverview } from "./mock";
import type {
  DockerSummary,
  NetworkThroughput,
  NotificationsSummary,
  OverviewSnapshot,
  Sourced,
  StorageUsage,
} from "./types";

const MOCK_REASON =
  "Unraid API unreachable or not configured — showing demo data.";

/**
 * Aggregates one overview snapshot from the Unraid GraphQL API.
 * Each section degrades independently: if a section's query fails it is
 * replaced with mock data and flagged, while live sections stay live.
 */
export async function getOverviewSnapshot(): Promise<Sourced<OverviewSnapshot>> {
  const client = getUnraidClient();
  const fetchedAt = new Date().toISOString();

  const identity = await safe(() =>
    client.request(SERVER_IDENTITY_QUERY).then(mapIdentity),
  );
  const metrics = await safe(async () => {
    const payload = await client.request(METRICS_QUERY);
    return {
      cpu: mapCpu(payload),
      memory: mapMemory(payload),
      network: mapNetwork(payload),
    };
  });
  const storage = await safe(() =>
    client.request(ARRAY_QUERY).then(mapStorage),
  );
  const docker = await safe(() =>
    client.request(DOCKER_QUERY).then(mapDocker),
  );
  const notifications = await safe(() =>
    client.request(NOTIFICATIONS_QUERY).then(mapNotifications),
  );

  const mock = mockOverview();
  const snapshot: OverviewSnapshot = {
    identity: identity ?? mock.identity,
    cpu: metrics?.cpu ?? mock.cpu,
    memory: metrics?.memory ?? mock.memory,
    storage: storage ?? mock.storage,
    network: metrics?.network ?? mock.network,
    docker: docker ?? mock.docker,
    notifications: notifications ?? mock.notifications,
  };

  const sections: Array<[boolean, unknown]> = [
    [identity !== null, identity],
    [metrics !== null, metrics],
    [storage !== null, storage],
    [docker !== null, docker],
    [notifications !== null, notifications],
  ];
  const liveCount = sections.filter(([ok]) => ok).length;

  const status =
    liveCount === 5 ? "live" : liveCount === 0 ? "mock" : "live";
  const failed = sections.filter(([ok]) => !ok).length;

  return {
    status: status as Sourced<OverviewSnapshot>["status"],
    data: snapshot,
    reason: failed > 0 ? `${failed} section(s) unavailable: ${MOCK_REASON}` : undefined,
    fetchedAt,
  };
}

/** Storage detail (disk list) for the storage overview section. */
export function storageFromSnapshot(snapshot: OverviewSnapshot): StorageUsage {
  return snapshot.storage;
}

/** Convenience helpers reused by dedicated routes later. */
export type { DockerSummary, NetworkThroughput, NotificationsSummary };

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (error) {
    if (!(error instanceof UnraidApiError)) {
      console.error("[unraid] unexpected error:", error);
    }
    return null;
  }
}
