import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapCpu,
  mapDocker,
  mapIdentity,
  mapMemory,
  mapNetworkInterfaces,
  mapNetworkThroughput,
  mapNotification,
  mapNotifications,
  mapStorage,
  mapSystemInfo,
  mapTemperature,
  mapVms,
  parseContainerHealth,
  splitLogLines,
} from "../src/server/unraid/mappers";

describe("mapIdentity", () => {
  it("prefers vars.name for the server name", () => {
    const identity = mapIdentity({
      vars: { name: "Tower", version: "7.3.2" },
      owner: { username: "root" },
      services: [{ name: "api", uptime: { timestamp: "2026-09-24T00:00:00Z" } }],
    });
    assert.equal(identity.serverName, "Tower");
    assert.equal(identity.osVersion, "7.3.2");
    assert.ok((identity.uptimeSeconds ?? 0) > 0);
  });

  it("falls back to owner username and tolerates missing services", () => {
    const identity = mapIdentity({ owner: { username: "admin" } });
    assert.equal(identity.serverName, "admin");
    assert.equal(identity.osVersion, null);
    assert.equal(identity.uptimeSeconds, null);
  });
});

describe("mapTemperature", () => {
  it("takes the max CPU package reading and separates board sensors", () => {
    const temperature = mapTemperature({
      metrics: {
        temperature: {
          summary: { hottest: { value: 69 }, warningCount: 1, criticalCount: 0 },
          sensors: [
            { type: "CPU_PACKAGE", current: { value: 66 }, warning: 70, critical: 85 },
            { type: "CPU_PACKAGE", current: { value: 68 }, warning: 70, critical: 85 },
            { type: "CPU_CORE", current: { value: 72 }, warning: 70, critical: 85 },
            { type: "CUSTOM", current: { value: 55 }, warning: 80, critical: 90 },
          ],
        },
      },
    });
    assert.equal(temperature.cpuC, 68);
    assert.equal(temperature.boardC, 55);
    assert.equal(temperature.hottestC, 69);
    assert.equal(temperature.warningCount, 1);
    assert.equal(temperature.criticalCount, 0);
  });

  it("returns nulls when no sensors exist", () => {
    const temperature = mapTemperature({ metrics: { temperature: { sensors: [] } } });
    assert.equal(temperature.cpuC, null);
    assert.equal(temperature.boardC, null);
  });
});

describe("mapCpu / mapMemory", () => {
  it("maps utilization and metadata", () => {
    const payload = {
      metrics: { cpu: { percentTotal: 12.5 }, memory: { total: "64", used: "32", percentTotal: 50 } },
      info: { cpu: { brand: "Test CPU", cores: 12, threads: 16 } },
    };
    const cpu = mapCpu(payload, null);
    assert.equal(cpu.percentTotal, 12.5);
    assert.equal(cpu.cores, 12);
    assert.equal(cpu.brand, "Test CPU");
    const memory = mapMemory(payload);
    assert.equal(memory.percentTotal, 50);
    assert.equal(memory.totalBytes, 64);
  });

  it("derives memory percentage when the field is missing", () => {
    const memory = mapMemory({ metrics: { memory: { total: 1000, used: 250 } } });
    assert.equal(memory.percentTotal, 25);
  });
});

describe("mapNetworkThroughput", () => {
  it("aggregates physical interfaces and ignores loopback/veth noise", () => {
    const throughput = mapNetworkThroughput({
      metrics: {
        network: [
          { name: "eth0", rxSec: 100, txSec: 50, bytesReceived: 1000, bytesSent: 500 },
          { name: "lo", rxSec: 9, txSec: 9, bytesReceived: 1, bytesSent: 1 },
          { name: "vethabc", rxSec: 7, txSec: 7, bytesReceived: 2, bytesSent: 2 },
        ],
      },
    });
    assert.equal(throughput.rxBytesPerSec, 100);
    assert.equal(throughput.txBytesPerSec, 50);
    assert.equal(throughput.totalReceivedBytes, 1000);
  });

  it("falls back to all interfaces when none are physical", () => {
    const throughput = mapNetworkThroughput({
      metrics: { network: [{ name: "lo", rxSec: 9, txSec: 9, bytesReceived: 1, bytesSent: 1 }] },
    });
    assert.equal(throughput.rxBytesPerSec, 9);
  });
});

describe("mapNetworkInterfaces", () => {
  it("joins interface inventory with live rates by name", () => {
    const interfaces = mapNetworkInterfaces(
      { networkInterfaces: [{ name: "br0", operstate: "up", virtual: false, ipAddress: "192.168.1.2" }] },
      { network: [{ name: "br0", rxSec: 10, txSec: 20, bytesReceived: 5, bytesSent: 6 }] },
    );
    assert.equal(interfaces.length, 1);
    assert.equal(interfaces[0]!.rxBytesPerSec, 10);
    assert.equal(interfaces[0]!.txBytesPerSec, 20);
    assert.equal(interfaces[0]!.ipAddress, "192.168.1.2");
  });
});

describe("mapStorage", () => {
  it("maps roles, converts kilobytes to bytes and keeps parity status", () => {
    const storage = mapStorage({
      array: {
        state: "STARTED",
        parityCheckStatus: { status: "COMPLETED", progress: 100 },
        capacity: { kilobytes: { total: "1000", used: "250", free: "750" } },
        disks: [{ name: "disk1", status: "DISK_OK", fsType: "xfs", fsSize: "500", fsUsed: "100", fsFree: "400", temp: 33 }],
        caches: [{ name: "cache", status: "DISK_OK", fsSize: "100", fsUsed: "10", fsFree: "90", temp: 40 }],
        parities: [{ name: "parity", status: "DISK_OK", temp: 31 }],
        boot: { name: "flash", status: "DISK_OK", fsSize: "32000", fsUsed: "16000", fsFree: "16000" },
      },
    });
    assert.equal(storage.state, "STARTED");
    assert.equal(storage.totalBytes, 1000 * 1024);
    assert.equal(storage.disks.length, 4);
    assert.deepEqual(
      storage.disks.map((disk) => disk.role),
      ["parity", "data", "cache", "flash"],
    );
    assert.equal(storage.disks[1]!.sizeBytes, 500 * 1024);
    assert.equal(storage.parityStatus, "COMPLETED");
  });

  it("survives an empty array payload", () => {
    const storage = mapStorage({});
    assert.equal(storage.state, "UNKNOWN");
    assert.deepEqual(storage.disks, []);
  });
});

describe("parseContainerHealth / mapDocker", () => {
  it("parses health from the docker status string", () => {
    assert.equal(parseContainerHealth("Up 2 hours (healthy)"), "healthy");
    assert.equal(parseContainerHealth("Up 2 hours (unhealthy)"), "unhealthy");
    assert.equal(parseContainerHealth("Up 2 hours (health: starting)"), "starting");
    assert.equal(parseContainerHealth("Exited (0) 3 days ago"), null);
    assert.equal(parseContainerHealth(null), null);
  });

  it("maps containers, counts running and strips name slashes", () => {
    const summary = mapDocker({
      docker: {
        containers: [
          { id: "1", names: ["/app"], image: "app:1", state: "RUNNING", status: "Up 1 hour (healthy)", autoStart: true, isUpdateAvailable: null, ports: [{ privatePort: 80, publicPort: 8080, type: "tcp" }] },
          { id: "2", names: ["/db"], image: "db:1", state: "EXITED", status: "Exited (0)", ports: [] },
        ],
      },
    });
    assert.equal(summary.running, 1);
    assert.equal(summary.total, 2);
    assert.equal(summary.containers[0]!.name, "app");
    assert.equal(summary.containers[0]!.health, "healthy");
    assert.equal(summary.containers[0]!.updateAvailable, false);
    assert.equal(summary.containers[1]!.health, null);
  });
});

describe("mapNotifications / mapNotification", () => {
  it("maps counts and recent warnings/alerts", () => {
    const summary = mapNotifications({
      notifications: {
        overview: { unread: { info: 2, warning: 1, alert: 3 } },
        warningsAndAlerts: [
          { id: "n1", title: "t", subject: "s", description: "d", importance: "ALERT", type: "UNREAD", formattedTimestamp: "Fri" },
        ],
      },
    });
    assert.deepEqual(summary.unreadCounts, { info: 2, warning: 1, alert: 3 });
    assert.equal(summary.recent[0]!.importance, "ALERT");
  });

  it("normalizes unknown importance to WARNING", () => {
    assert.equal(mapNotification({ id: "x", importance: "WEIRD", type: "UNREAD" }).importance, "WARNING");
    assert.equal(mapNotification({ id: "x", importance: "INFO", type: "UNREAD" }).type, "UNREAD");
  });
});

describe("mapVms", () => {
  it("counts running VMs", () => {
    const vms = mapVms({ vms: { domains: [{ id: "a", name: "Ubuntu", state: "SHUTOFF" }, { id: "b", name: "Win", state: "RUNNING" }] } });
    assert.equal(vms.total, 2);
    assert.equal(vms.running, 1);
    assert.equal(vms.vms[0]!.state, "SHUTOFF");
  });
});

describe("mapSystemInfo", () => {
  it("maps platform fields defensively", () => {
    const info = mapSystemInfo({
      info: {
        os: { hostname: "homeserver", distro: "Unraid OS", kernel: "6.18.38", arch: "x64", uefi: true },
        cpu: { brand: "i5", cores: 12, threads: 16, speed: 3.48 },
        baseboard: { manufacturer: "Intel", model: "NUC13" },
        system: { manufacturer: "Intel", model: "NUC13ANHi5", virtual: false },
      },
    });
    assert.equal(info.hostname, "homeserver");
    assert.equal(info.uefi, true);
    assert.equal(info.cpuCores, 12);
    assert.equal(info.virtualized, false);
  });
});

describe("splitLogLines", () => {
  it("splits and drops empty lines", () => {
    assert.deepEqual(splitLogLines("a\nb\n\nc\n"), ["a", "b", "c"]);
    assert.deepEqual(splitLogLines(null), []);
    assert.deepEqual(splitLogLines(42), []);
  });
});
