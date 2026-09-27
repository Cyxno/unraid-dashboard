import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findUnsupported,
  inspectToSnapshot,
  snapshotToRunArgs,
} from "../src/../helper/recreate";
import type { ManagedContainer } from "../src/server/docker/model";
import { updateGate } from "../src/server/docker/policy";

/** v0.7.8 hardening: recreate-parity, unsupported-detectie, locks. */

const BASE_INSPECT = {
  Name: "/pilot",
  Image: "sha256:img",
  RepoDigests: [],
  Created: "2026-01-01T00:00:00Z",
  State: { Running: true, Health: { Status: "healthy" } },
  Config: {
    Image: "busybox:latest",
    Env: ["FOO=bar", "SECRET=hush"],
    Cmd: ["httpd", "-f"],
    Entrypoint: ["/bin/sh", "-c"],
    WorkingDir: "/www",
    User: "1000:1000",
    Hostname: "pilot-host",
    Domainname: "example.lan",
    Labels: { app: "pilot", "net.unraid.docker.managed": "dockerman" },
    ExposedPorts: { "80/tcp": {} },
    Volumes: { "/data": {} },
    StopSignal: "SIGUSR1",
    StopTimeout: 30,
    Healthcheck: { Test: ["CMD-SHELL", "wget -qO- localhost"], Interval: 3e10, Timeout: 5e9, Retries: 3, StartPeriod: 1e10 },
  },
  HostConfig: {
    NetworkMode: "pilot-net",
    RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
    PortBindings: { "80/tcp": [{ HostIp: "192.168.1.2", HostPort: "8391" }] },
    Binds: ["/mnt/user/appdata/pilot:/data:rw"],
    Privileged: false,
    ReadonlyRootfs: true,
    CapAdd: ["NET_ADMIN"],
    CapDrop: ["CHOWN"],
    SecurityOpt: ["no-new-privileges"],
    Devices: [],
    DeviceRequests: [],
    GroupAdd: ["999"],
    ExtraHosts: ["db:192.168.1.5"],
    Dns: ["192.168.1.1"],
    DNSOptions: ["ndots:2"],
    DNSSearch: ["lan"],
    ShmSize: 134217728,
    Sysctls: { "net.ipv4.ip_forward": "1" },
    Ulimits: [{ Name: "nofile", Soft: 8192, Hard: 16384 }],
    Tmpfs: { "/run": "rw,size=64m" },
    Runtime: "runc",
    PidsLimit: 512,
    Memory: 536870912,
    MemorySwap: 1073741824,
    NanoCpus: 1500000000,
    CpuPeriod: 100000,
    CpuQuota: 150000,
    CpusetCpus: "0-1",
    CpusetMems: "",
    OomKillDisable: true,
    OomScoreAdj: 250,
    LogConfig: { Type: "json-file", Config: { "max-size": "10m" } },
    Init: true,
    AutoRemove: false,
    CgroupnsMode: "private",
    IpcMode: "private",
    PidMode: "",
    UTSMode: "",
  },
  Mounts: [
    { Type: "bind", Source: "/mnt/user/appdata/pilot", Destination: "/data", Mode: "rw", RW: true },
    { Type: "volume", Source: "pilot-vol", Destination: "/var/lib/pilot", Mode: "z", RW: true },
    { Type: "tmpfs", Destination: "/runFast", Mode: "rw", RW: true },
  ],
  NetworkSettings: {
    MacAddress: "02:42:ac:11:00:02",
    Networks: {
      "pilot-net": { Aliases: ["pilot-alias"], IPAMConfig: { IPv4Address: "172.30.0.5" }, MacAddress: "02:42:ac:11:00:02" },
    },
  },
};

type Snap = ReturnType<typeof inspectToSnapshot> & { usesVolumesFrom?: boolean };

function argsOf(snap: Snap) {
  return snapshotToRunArgs(snap, "busybox:latest").args;
}

describe("v0.7.8 recreate-engine coverage", () => {
  it("snapshot bevat alle kritieke velden", () => {
    const snap: Snap = inspectToSnapshot(BASE_INSPECT);
    assert.equal(snap.cmd.join(" "), "httpd -f");
    assert.deepEqual(snap.entrypoint, ["/bin/sh", "-c"]);
    assert.equal(snap.workingDir, "/www");
    assert.equal(snap.user, "1000:1000");
    assert.equal(snap.stopSignal, "SIGUSR1");
    assert.equal(snap.stopTimeout, 30);
    assert.equal(snap.readonlyRootfs, true);
    assert.deepEqual(snap.securityOpt, ["no-new-privileges"]);
    assert.deepEqual(snap.aliases, ["pilot-alias"]);
    assert.equal(snap.ipamV4, "172.30.0.5");
    assert.equal(snap.macAddress, "02:42:ac:11:00:02");
    assert.equal(snap.pidsLimit, 512);
    assert.equal(snap.memory, 536870912);
    assert.equal(snap.memorySwap, 1073741824);
    assert.equal(snap.nanoCpus, 1500000000);
    assert.equal(snap.oomKillDisable, true);
    assert.equal(snap.oomScoreAdj, 250);
    assert.equal(snap.logConfig.type, "json-file");
    assert.equal(snap.init, true);
    assert.equal(snap.shmSize, 134217728);
    assert.deepEqual(snap.ulimits, [{ name: "nofile", soft: 8192, hard: 16384 }]);
    assert.deepEqual(snap.tmpfs, { "/run": "rw,size=64m" });
    assert.equal(snap.healthcheck?.retries, 3);
    assert.deepEqual(snap.volumesDeclared, { "/data": {} });
  });

  it("run args re-applieren alle ondersteunde velden", () => {
    const snap: Snap = inspectToSnapshot(BASE_INSPECT);
    const args = argsOf(snap).join(" ");
    for (const fragment of [
      "--name pilot",
      "--network pilot-net",
      "--network-alias pilot-alias",
      "--ip 172.30.0.5",
      "--mac-address 02:42:ac:11:00:02",
      "--restart unless-stopped",
      "-p 192.168.1.2:8391:80/tcp",
      "-v /mnt/user/appdata/pilot:/data:rw",
      "-v pilot-vol:/var/lib/pilot:z",
      "--tmpfs /run:rw,size=64m",
      "--tmpfs /runFast",
      "-e FOO=bar",
      "-e SECRET=hush",
      "--entrypoint [\"/bin/sh\",\"-c\"]",
      "-w /www",
      "--user 1000:1000",
      "--hostname pilot-host",
      "--domainname example.lan",
      "--label app=pilot",
      "--stop-signal SIGUSR1",
      "--stop-timeout 30",
      "--init",
      "--cap-add NET_ADMIN",
      "--cap-drop CHOWN",
      "--security-opt no-new-privileges",
      "--group-add 999",
      "--add-host db:192.168.1.5",
      "--dns 192.168.1.1",
      "--dns-option ndots:2",
      "--dns-search lan",
      "--shm-size 134217728",
      "--sysctl net.ipv4.ip_forward=1",
      "--ulimit nofile=8192:16384",
      "--runtime runc",
      "--pids-limit 512",
      "--memory 536870912",
      "--memory-swap 1073741824",
      "--cpus 1.5",
      "--cpu-period 100000",
      "--cpu-quota 150000",
      "--cpuset-cpus 0-1",
      "--oom-kill-disable",
      "--oom-score-adj 250",
      "--log-driver json-file",
      "--log-opt max-size=10m",
      "--health-cmd wget -qO- localhost",
      "--health-interval 30s",
      "--health-timeout 5s",
      "--health-retries 3",
      "--health-start-period 10s",
      "--read-only",
    ]) {
      assert.ok(args.includes(fragment), `ontbreekt: ${fragment} in ${args.slice(0, 400)}`);
    }
  });

  it("cmd wordt als post-image args teruggegeven", () => {
    const snap: Snap = inspectToSnapshot(BASE_INSPECT);
    const { cmd } = snapshotToRunArgs(snap, "busybox:latest");
    assert.deepEqual(cmd, ["httpd", "-f"]);
  });

  it("unsupported detectie: multi-network, GPU, container:-mode, static-IP-op-bridge, custom-EXPOSE, volumes-from", () => {
    const multiNet: Snap = inspectToSnapshot({
      ...BASE_INSPECT,
      NetworkSettings: { Networks: { bridge: {}, "media_backend": {} } },
    });
    assert.ok(findUnsupported(multiNet, []).some((r) => /multiple networks/.test(r)));

    const gpu: Snap = inspectToSnapshot(BASE_INSPECT);
    gpu.deviceRequests = [{ Driver: "nvidia" }];
    assert.ok(findUnsupported(gpu, []).some((r) => /GPU/.test(r)));

    const containerNet: Snap = inspectToSnapshot(BASE_INSPECT);
    containerNet.networkMode = "container:abc123";
    assert.ok(findUnsupported(containerNet, []).some((r) => /container:/.test(r)));

    const bridgeStatic: Snap = inspectToSnapshot(BASE_INSPECT);
    bridgeStatic.networkMode = "bridge";
    bridgeStatic.ipamV4 = "172.17.0.9";
    assert.ok(findUnsupported(bridgeStatic, ["80/tcp"]).some((r) => /default bridge/.test(r)));

    // Container exposéert een poort die de image zelf niet exposéert.
    const withExtraExpose: Snap = inspectToSnapshot({
      ...BASE_INSPECT,
      Config: { ...BASE_INSPECT.Config, ExposedPorts: { "80/tcp": {}, "9090/tcp": {} } },
    });
    assert.ok(
      findUnsupported(withExtraExpose, ["80/tcp"]).some((r) => /EXPOSE.*9090/.test(r)),
    );

    const volsFrom: Snap = inspectToSnapshot(BASE_INSPECT);
    volsFrom.usesVolumesFrom = true;
    assert.ok(findUnsupported(volsFrom, []).some((r) => /volumes-from/i.test(r)));

    const badMount: Snap = inspectToSnapshot(BASE_INSPECT);
    badMount.mounts = [{ type: "npipe", dest: "\\\\.\\pipe\\x", source: null, mode: "" }];
    assert.ok(findUnsupported(badMount, []).some((r) => /npipe/.test(r)));
  });

  it("supported config geeft GEEN unsupported-redenen", () => {
    const snap: Snap = inspectToSnapshot(BASE_INSPECT);
    assert.deepEqual(findUnsupported(snap, ["80/tcp"]), []);
  });
});

describe("v0.7.8 policy: unknown ownership + unsupported blokkeren", () => {
  it("unsupported redenen blokkeren met concrete tekst", () => {
    const gate = updateGate(container({
      name: "weird",
      update_available: true,
    }) as ManagedContainer & { unsupported?: string[] });
    // zonder unsupported-veld: normaal updatable
    assert.equal(gate.canUpdate, true);

    const blocked = updateGate({
      ...container({ name: "weird", update_available: true }),
      unsupported: ["GPU device requests (DeviceRequests)"],
    } as ManagedContainer & { unsupported?: string[] });
    assert.equal(blocked.canUpdate, false);
    assert.match(blocked.blockedReason ?? "", /GPU/);
  });

  it("externallyManaged-label blokkeert", () => {
    const gate = updateGate(container({ name: "ci-app", externallyManaged: true }));
    assert.equal(gate.canUpdate, false);
    assert.match(gate.blockedReason ?? "", /\(label\)/);
  });
});

describe("v0.7.8 mutable-latest rollback-identiteit", () => {
  it("rollback-args zijn puur pre-image; image-ID gaat via dockerRunWithEnv", () => {
    const snap: Snap = inspectToSnapshot(BASE_INSPECT);
    // Container draaide imageId X; tag is inmiddels naar Y gere-point.
    snap.image = "busybox:latest";
    snap.imageId = "sha256:v1id";
    const { args, cmd } = snapshotToRunArgs(snap, snap.imageId);
    // De argv bevat nergens de mutable tag: het image-ID wordt als los
    // argument aan dockerRunWithEnv gegeven (dus nooit de actuele
    // betekenis van :latest).
    assert.ok(!args.includes("busybox:latest"));
    assert.deepEqual(cmd, ["httpd", "-f"]);
  });
});

function container(overrides: Partial<ManagedContainer> = {}): ManagedContainer {
  return {
    id: "abc",
    name: "some-container",
    image: "ghcr.io/owner/app:1.0.0",
    tag: "1.0.0",
    image_id: "sha256:imageid",
    current_digest: "sha256:old",
    remote_digest: "sha256:new",
    registry: "ghcr.io",
    management_type: "unraid",
    management_source: "dockerman-label:owner/app",
    update_strategy: "unraid_template",
    update_available: true,
    update_status: "UPDATE_AVAILABLE",
    risk: "LOW",
    policy: "notify",
    rollback_available: false,
    externallyManaged: false,
    health: "healthy",
    last_checked: "2026-09-27T20:00:00Z",
    last_updated: null,
    ...overrides,
  };
}
