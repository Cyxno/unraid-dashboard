import type {
  CpuUsage,
  DockerSummary,
  MemoryUsage,
  NetworkThroughput,
  NotificationsSummary,
  StorageUsage,
  SystemIdentity,
} from "@/lib/api-types";

/**
 * Demo data used ONLY when the Unraid API has never responded since
 * process start. Returned with `status: "demo"` and labelled in the UI —
 * never presented as live, and never substituted after real data exists.
 */
export interface DemoData {
  identity: SystemIdentity;
  cpu: CpuUsage;
  memory: MemoryUsage;
  storage: StorageUsage;
  network: NetworkThroughput;
  docker: DockerSummary;
  notifications: NotificationsSummary;
}

export function mockOverview(): DemoData {
  const now = Date.now();
  const GB = 1024 ** 3;
  return {
    identity: {
      serverName: "Demo Tower",
      osVersion: "7.2.0",
      uptimeSeconds: 41 * 24 * 3600 + 7 * 3600,
    },
    cpu: {
      percentTotal: 23.4,
      cores: 12,
      threads: 24,
      brand: "Demo CPU (fallback data)",
      temperature: null,
    },
    memory: {
      percentTotal: 48.75,
      usedBytes: 31.2 * GB,
      totalBytes: 64 * GB,
      availableBytes: (64 - 31.2) * GB,
    },
    storage: {
      state: "STARTED",
      totalBytes: 42 * GB,
      usedBytes: 21.6 * GB,
      freeBytes: 20.4 * GB,
      parityStatus: "COMPLETED",
      parityProgressPercent: null,
      disks: [
        { name: "parity", device: null, role: "parity", state: "DISK_OK", fsType: null, sizeBytes: 8 * GB, usedBytes: null, freeBytes: null, temperatureC: 34, fsColor: null },
        { name: "disk1", device: "sdb", role: "data", state: "DISK_OK", fsType: "xfs", sizeBytes: 8 * GB, usedBytes: 4.1 * GB, freeBytes: 3.9 * GB, temperatureC: 36, fsColor: "GREEN" },
        { name: "disk2", device: "sdc", role: "data", state: "DISK_OK", fsType: "xfs", sizeBytes: 8 * GB, usedBytes: 5.3 * GB, freeBytes: 2.7 * GB, temperatureC: 37, fsColor: "GREEN" },
        { name: "cache", device: "sdd", role: "cache", state: "DISK_OK", fsType: "btrfs", sizeBytes: 2 * GB, usedBytes: 0.9 * GB, freeBytes: 1.1 * GB, temperatureC: 39, fsColor: "GREEN" },
        { name: "flash", device: "sda", role: "flash", state: "DISK_OK", fsType: "vfat", sizeBytes: 0.03 * GB, usedBytes: 0.01 * GB, freeBytes: 0.02 * GB, temperatureC: null, fsColor: "GREEN" },
      ],
    },
    network: {
      rxBytesPerSec: 8.4 * 1024 ** 2,
      txBytesPerSec: 2.1 * 1024 ** 2,
      totalReceivedBytes: 18.3 * 1024 ** 4,
      totalSentBytes: 9.7 * 1024 ** 4,
    },
    docker: {
      running: 5,
      total: 7,
      containers: [
        { id: "m1", name: "jellyfin", image: "lscr.io/linuxserver/jellyfin", state: "RUNNING", status: "Up 6 days (healthy)", health: "healthy", autoStart: true, updateAvailable: false, iconUrl: null, webUiUrl: null, createdEpochSeconds: null,
        composeProject: null,
        metrics: null, ports: [{ privatePort: 8096, publicPort: 8096, type: "tcp" }] },
        { id: "m2", name: "nextcloud", image: "nextcloud:latest", state: "RUNNING", status: "Up 6 days", health: null, autoStart: true, updateAvailable: true, iconUrl: null, webUiUrl: null, createdEpochSeconds: null,
        composeProject: null,
        metrics: null, ports: [] },
        { id: "m3", name: "swag", image: "lscr.io/linuxserver/swag", state: "RUNNING", status: "Up 6 days", health: null, autoStart: true, updateAvailable: false, iconUrl: null, webUiUrl: null, createdEpochSeconds: null,
        composeProject: null,
        metrics: null, ports: [{ privatePort: 443, publicPort: 8443, type: "tcp" }] },
        { id: "m4", name: "postgres", image: "postgres:16", state: "RUNNING", status: "Up 6 days (healthy)", health: "healthy", autoStart: true, updateAvailable: false, iconUrl: null, webUiUrl: null, createdEpochSeconds: null,
        composeProject: null,
        metrics: null, ports: [] },
        { id: "m5", name: "homeassistant", image: "ghcr.io/home-assistant/...", state: "RUNNING", status: "Up 2 days", health: null, autoStart: true, updateAvailable: false, iconUrl: null, webUiUrl: null, createdEpochSeconds: null,
        composeProject: null,
        metrics: null, ports: [{ privatePort: 8123, publicPort: 8123, type: "tcp" }] },
        { id: "m6", name: "pihole", image: "pihole/pihole", state: "EXITED", status: "Exited (0) 3 days ago", health: null, autoStart: false, updateAvailable: false, iconUrl: null, webUiUrl: null, createdEpochSeconds: null,
        composeProject: null,
        metrics: null, ports: [] },
        { id: "m7", name: "qbittorrent", image: "lscr.io/linuxserver/qbittorrent", state: "PAUSED", status: "Paused", health: null, autoStart: false, updateAvailable: true, iconUrl: null, webUiUrl: null, createdEpochSeconds: null,
        composeProject: null,
        metrics: null, ports: [] },
      ],
    },
    notifications: {
      unreadCounts: { info: 3, warning: 1, alert: 0 },
      recent: [
        { id: "n1", title: "update available", subject: "nextcloud: update ready", description: "A newer version of this container is available.", importance: "WARNING", type: "UNREAD", timestamp: new Date(now - 3 * 3600_000).toISOString() },
        { id: "n2", title: "array started", subject: "Array started", description: "Array was started with all disks healthy.", importance: "INFO", type: "UNREAD", timestamp: new Date(now - 6 * 3600_000).toISOString() },
        { id: "n3", title: "parity complete", subject: "Parity check finished", description: "Scheduled parity check completed with 0 errors.", importance: "INFO", type: "UNREAD", timestamp: new Date(now - 26 * 3600_000).toISOString() },
      ],
    },
  };
}
