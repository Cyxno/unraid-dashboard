import type { OverviewSnapshot } from "./types";

/**
 * Demo data used ONLY when the Unraid API is unreachable or not yet
 * configured. Responses carrying this data are flagged `status: "mock"`
 * so the UI can label them explicitly — it is never presented as live.
 */
export function mockOverview(): OverviewSnapshot {
  const now = Date.now();
  return {
    identity: {
      serverName: "Demo Tower",
      osVersion: "7.2.0",
      uptimeSeconds: 41 * 24 * 3600 + 7 * 3600,
    },
    cpu: { percentTotal: 23.4, cores: 12, brand: "Demo CPU (fallback data)" },
    memory: {
      percentTotal: 48.2,
      usedBytes: 31.2 * 1024 ** 3,
      totalBytes: 64 * 1024 ** 3,
    },
    storage: {
      state: "STARTED",
      totalBytes: 42 * 1024 ** 3,
      usedBytes: 21.6 * 1024 ** 3,
      freeBytes: 20.4 * 1024 ** 3,
      parityStatus: "COMPLETED",
      disks: [
        { name: "parity", role: "parity", state: "DISK_OK", sizeBytes: 8 * 1024 ** 3, usedBytes: null, freeBytes: null, temperatureC: 34, fsColor: null },
        { name: "disk1", role: "data", state: "DISK_OK", sizeBytes: 8 * 1024 ** 3, usedBytes: 4.1 * 1024 ** 3, freeBytes: 3.9 * 1024 ** 3, temperatureC: 36, fsColor: "GREEN" },
        { name: "disk2", role: "data", state: "DISK_OK", sizeBytes: 8 * 1024 ** 3, usedBytes: 5.3 * 1024 ** 3, freeBytes: 2.7 * 1024 ** 3, temperatureC: 37, fsColor: "GREEN" },
        { name: "cache", role: "cache", state: "DISK_OK", sizeBytes: 2 * 1024 ** 3, usedBytes: 0.9 * 1024 ** 3, freeBytes: 1.1 * 1024 ** 3, temperatureC: 39, fsColor: "GREEN" },
        { name: "flash", role: "flash", state: "DISK_OK", sizeBytes: 0.03 * 1024 ** 3, usedBytes: 0.01 * 1024 ** 3, freeBytes: 0.02 * 1024 ** 3, temperatureC: null, fsColor: "GREEN" },
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
        { id: "m1", name: "jellyfin", image: "lscr.io/linuxserver/jellyfin", state: "RUNNING", status: "Up 6 days", autoStart: true, updateAvailable: false, cpuPercent: 4.2, memoryPercent: 11.3 },
        { id: "m2", name: "nextcloud", image: "nextcloud:latest", state: "RUNNING", status: "Up 6 days", autoStart: true, updateAvailable: true, cpuPercent: 1.1, memoryPercent: 8.7 },
        { id: "m3", name: "swag", image: "lscr.io/linuxserver/swag", state: "RUNNING", status: "Up 6 days", autoStart: true, updateAvailable: false, cpuPercent: 0.4, memoryPercent: 2.1 },
        { id: "m4", name: "postgres", image: "postgres:16", state: "RUNNING", status: "Up 6 days", autoStart: true, updateAvailable: false, cpuPercent: 0.8, memoryPercent: 5.4 },
        { id: "m5", name: "homeassistant", image: "ghcr.io/home-assistant/...", state: "RUNNING", status: "Up 2 days", autoStart: true, updateAvailable: false, cpuPercent: 2.6, memoryPercent: 9.2 },
        { id: "m6", name: "pihole", image: "pihole/pihole", state: "EXITED", status: "Exited (0) 3 days ago", autoStart: false, updateAvailable: false, cpuPercent: 0, memoryPercent: 0 },
        { id: "m7", name: "qbittorrent", image: "lscr.io/linuxserver/qbittorrent", state: "PAUSED", status: "Paused", autoStart: false, updateAvailable: true, cpuPercent: 0, memoryPercent: 1.8 },
      ],
    },
    notifications: {
      unreadCounts: { info: 3, warning: 1, alert: 0 },
      recent: [
        { id: "n1", title: "update available", subject: "nextcloud: update ready", description: "A newer version of this container is available.", importance: "WARNING", timestamp: new Date(now - 3 * 3600_000).toISOString() },
        { id: "n2", title: "array started", subject: "Array started", description: "Array was started with all disks healthy.", importance: "INFO", timestamp: new Date(now - 6 * 3600_000).toISOString() },
        { id: "n3", title: "parity complete", subject: "Parity check finished", description: "Scheduled parity check completed with 0 errors.", importance: "INFO", timestamp: new Date(now - 26 * 3600_000).toISOString() },
      ],
    },
  };
}
