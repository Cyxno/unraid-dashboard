/**
 * Recreate engine (v0.7.8): pure functions converting a container inspect
 * snapshot into docker run arguments — and detecting anything that cannot
 * be faithfully recreated. Used by the update helper; unit-testable.
 *
 * Design rule: apply everything supported, FAIL CLOSED (with a concrete
 * reason) on anything not explicitly supported. Silent degradation is a
 * blocker, never a warning.
 */

const UNSUPPORTED_PREFIX = "generic recreate not supported:";

/** Converts docker Duration (nanoseconds) to a --flag friendly string. */
function nsToDuration(ns) {
  if (ns === 0 || ns === null || ns === undefined) return "0s";
  const units = [
    [1e9, "s"], [6e10, "m"], [3.6e12, "h"],
  ];
  if (ns % 1e9 !== 0 && ns % 1e6 === 0) return `${ns / 1e6}ms`;
  for (const [factor, suffix] of units) {
    if (ns % factor === 0) return `${ns / factor}${suffix}`;
  }
  return `${ns}ns`;
}

/** Inspect → full snapshot (superset; env values included — caller must persist 0600). */
function inspectToSnapshot(d) {
  const h = d.HostConfig ?? {};
  const nets = d.NetworkSettings?.Networks ?? {};
  const netNames = Object.keys(nets);
  return {
    schemaVersion: 1,
    name: d.Name?.replace(/^\//, "") ?? "",
    image: d.Config?.Image ?? null,
    imageId: d.Image ?? null,
    repoDigests: d.RepoDigests ?? [],
    env: d.Config?.Env ?? [],
    cmd: d.Config?.Cmd ?? [],
    entrypoint: d.Config?.Entrypoint ?? null,
    workingDir: d.Config?.WorkingDir ?? null,
    user: d.Config?.User || null,
    hostname: d.Config?.Hostname || null,
    domainname: d.Config?.Domainname || null,
    labels: d.Config?.Labels ?? {},
    exposedPorts: Object.keys(d.Config?.ExposedPorts ?? {}),
    portBindings: h.PortBindings ?? {},
    binds: h.Binds ?? [],
    mounts: (d.Mounts ?? []).map((m) => ({ type: m.Type, source: m.Source ?? null, dest: m.Destination, mode: m.Mode ?? (m.RW ? "rw" : "ro") })),
    volumesDeclared: d.Config?.Volumes ?? {},
    networkMode: h.NetworkMode ?? "default",
    networkNames: netNames,
    aliases: netNames.length === 1 ? (nets[netNames[0]]?.Aliases ?? []) : [],
    ipamV4: netNames.length === 1 ? (nets[netNames[0]]?.IPAMConfig?.IPv4Address ?? null) : null,
    ipamV6: netNames.length === 1 ? (nets[netNames[0]]?.IPAMConfig?.IPv6Address ?? null) : null,
    macAddress: d.NetworkSettings?.MacAddress || d.Config?.MacAddress || null,
    restartPolicy: h.RestartPolicy?.Name ?? "no",
    restartMaxRetries: h.RestartPolicy?.MaximumRetryCount ?? 0,
    autoRemove: h.AutoRemove === true,
    privileged: h.Privileged === true,
    readonlyRootfs: h.ReadonlyRootfs === true,
    capAdd: h.CapAdd ?? [],
    capDrop: h.CapDrop ?? [],
    securityOpt: h.SecurityOpt ?? [],
    devices: (h.Devices ?? []).map((dev) => `${dev.PathOnHost}:${dev.PathInContainer}:${dev.CgroupPermissions ?? "rwm"}`),
    deviceRequests: h.DeviceRequests ?? [],
    groupAdd: h.GroupAdd ?? [],
    extraHosts: h.ExtraHosts ?? [],
    dns: h.Dns ?? [],
    dnsOptions: h.DNSOptions ?? [],
    dnsSearch: h.DNSSearch ?? [],
    shmSize: h.ShmSize ?? 0,
    sysctls: h.Sysctls ?? {},
    ulimits: (h.Ulimits ?? []).map((u) => ({ name: u.Name, soft: u.Soft, hard: u.Hard })),
    tmpfs: h.Tmpfs ?? {},
    runtime: h.Runtime || null,
    pidsLimit: h.PidsLimit ?? null,
    memory: h.Memory ?? 0,
    memorySwap: h.MemorySwap ?? 0,
    nanoCpus: h.NanoCpus ?? 0,
    cpuPeriod: h.CpuPeriod ?? 0,
    cpuQuota: h.CpuQuota ?? 0,
    cpusetCpus: h.CpusetCpus || null,
    cpusetMems: h.CpusetMems || null,
    oomKillDisable: h.OomKillDisable === true,
    oomScoreAdj: h.OomScoreAdj ?? 0,
    logConfig: { type: h.LogConfig?.Type ?? null, opts: h.LogConfig?.Config ?? {} },
    init: h.Init === true,
    stopSignal: d.Config?.StopSignal || null,
    stopTimeout: d.Config?.StopTimeout ?? null,
    healthcheck: d.Config?.Healthcheck
      ? {
          test: d.Config.Healthcheck.Test ?? [],
          interval: d.Config.Healthcheck.Interval ?? 0,
          timeout: d.Config.Healthcheck.Timeout ?? 0,
          retries: d.Config.Healthcheck.Retries ?? 0,
          startPeriod: d.Config.Healthcheck.StartPeriod ?? 0,
        }
      : null,
    cgroupnsMode: h.CgroupnsMode || null,
    ipcMode: h.IpcMode || null,
    pidMode: h.PidMode || null,
    utsMode: h.UTSMode || null,
    snapshotAt: new Date().toISOString(),
  };
}

/**
 * Detects container features that the generic recreate cannot faithfully
 * re-apply. Empty array = safe to recreate. Every entry is a concrete,
 * user-facing reason.
 */
function findUnsupported(snap, imageExposedPorts) {
  const reasons = [];
  if ((snap.networkNames ?? []).length > 1) {
    reasons.push("connected to multiple networks — recreate supports a single network");
  }
  if (typeof snap.networkMode === "string" && snap.networkMode.startsWith("container:")) {
    reasons.push("shares another container's network namespace (container: mode)");
  }
  if ((snap.deviceRequests ?? []).length > 0) {
    reasons.push("GPU device requests (DeviceRequests)");
  }
  const badMounts = (snap.mounts ?? []).filter(
    (m) => !["bind", "volume", "tmpfs"].includes(m.type),
  );
  if (badMounts.length > 0) {
    reasons.push(`unsupported mount type(s): ${[...new Set(badMounts.map((m) => m.type))].join(", ")}`);
  }
  if (snap.ipamV6) {
    reasons.push("static IPv6 address (IPAMConfig.IPv6Address)");
  }
  if (snap.networkMode === "bridge" && (snap.ipamV4 || snap.ipamV6)) {
    reasons.push("static IP on the default bridge");
  }
  if (imageExposedPorts && imageExposedPorts.length > 0) {
    const imageSet = new Set(imageExposedPorts);
    const extra = (snap.exposedPorts ?? []).filter((p) => !imageSet.has(p));
    if (extra.length > 0) {
      reasons.push(`custom EXPOSE beyond the image: ${extra.join(", ")}`);
    }
  }
  if ((snap.volumesFrom ?? []).length > 0 || snap.usesVolumesFrom === true) {
    reasons.push("uses --volumes-from");
  }
  return reasons;
}

/** Formats a single ulimit as docker run value. */
function ulimitValue(u) {
  if (u.soft === u.hard) return `${u.name}=${u.soft}`;
  return `${u.name}=${u.soft}:${u.hard}`;
}

/**
 * Snapshot → docker run argv. Returns { args, cmd } where cmd is appended
 * after the image ref (the container's own command override).
 */
function snapshotToRunArgs(snap, imageRef) {
  const args = ["run", "-d"];
  const push = (...entries) => args.push(...entries.filter((entry) => entry !== undefined && entry !== null && entry !== ""));

  push("--name", snap.name);
  // Network: explicit modes; a single custom network also carries alias/ip.
  if (snap.networkMode && snap.networkMode !== "default") {
    push("--network", snap.networkMode);
  }
  for (const alias of snap.aliases ?? []) push("--network-alias", alias);
  if (snap.ipamV4) push("--ip", snap.ipamV4);
  if (snap.macAddress) push("--mac-address", snap.macAddress);

  if (snap.restartPolicy && snap.restartPolicy !== "no") {
    push("--restart", snap.restartMaxRetries > 0 ? `${snap.restartPolicy}:${snap.restartMaxRetries}` : snap.restartPolicy);
  }
  if (snap.autoRemove) push("--rm");
  if (snap.privileged) push("--privileged");
  if (snap.readonlyRootfs) push("--read-only");

  for (const [port, bindings] of Object.entries(snap.portBindings ?? {})) {
    for (const binding of bindings ?? []) {
      const hostIp = binding.HostIp ?? "";
      if (hostIp) push("-p", `${hostIp}:${binding.HostPort}:${port}`);
      else push("-p", `${binding.HostPort}:${port}`);
    }
  }
  for (const bind of snap.binds ?? []) push("-v", bind);
  // Named volumes from Mounts (binds already covered; volume + tmpfs here).
  for (const m of snap.mounts ?? []) {
    if (m.type === "volume" && m.source) push("-v", `${m.source}:${m.dest}${m.mode && m.mode !== "rw" ? `:${m.mode}` : ""}`);
    if (m.type === "tmpfs" && m.dest) push("--tmpfs", `${m.dest}${m.mode && m.mode !== "rw" ? `:${m.mode}` : ""}`);
  }
  // Declared volumes: re-declare only when no bind/volume mount already
  // covers the destination (otherwise an anonymous volume would shadow it).
  const coveredDests = new Set([
    ...(snap.binds ?? []).map((bind) => bind.split(":")[1]),
    ...(snap.mounts ?? []).map((m) => m.dest),
  ]);
  for (const dest of Object.keys(snap.volumesDeclared ?? {})) {
    if (!coveredDests.has(dest)) push("-v", dest);
  }
  for (const dest of Object.keys(snap.tmpfs ?? {})) {
    const mode = snap.tmpfs[dest];
    push("--tmpfs", mode ? `${dest}:${mode}` : dest);
  }

  // Env is bewust NIET in de argv: het gaat uitsluitend via het 0600
  // --env-file (zie dockerRunWithEnv) zodat secrets nooit in process-
  // lijsten of logs belanden.
  // docker's --entrypoint takes the bare executable path. A JSON-encoded
  // array here would be executed LITERALLY (exit 127, as caught live by the
  // v0.8.0 disposable-container test).
  if (snap.entrypoint) {
    const entrypoint = Array.isArray(snap.entrypoint) ? (snap.entrypoint[0] ?? null) : snap.entrypoint;
    if (entrypoint) push("--entrypoint", entrypoint);
    // Additional entrypoint elements are prepended to cmd (docker semantics).
    if (Array.isArray(snap.entrypoint) && snap.entrypoint.length > 1) {
      snap.cmd = [...snap.entrypoint.slice(1), ...(Array.isArray(snap.cmd) ? snap.cmd : [])];
    }
  }
  if (snap.workingDir) push("-w", snap.workingDir);
  if (snap.user) push("--user", snap.user);
  if (snap.hostname) push("--hostname", snap.hostname);
  if (snap.domainname) push("--domainname", snap.domainname);
  for (const [key, value] of Object.entries(snap.labels ?? {})) push("--label", `${key}=${value}`);
  if (snap.stopSignal) push("--stop-signal", snap.stopSignal);
  if (snap.stopTimeout !== null && snap.stopTimeout !== undefined) push("--stop-timeout", String(snap.stopTimeout));
  if (snap.init) push("--init");

  for (const cap of snap.capAdd ?? []) push("--cap-add", cap);
  for (const cap of snap.capDrop ?? []) push("--cap-drop", cap);
  for (const opt of snap.securityOpt ?? []) push("--security-opt", opt);
  for (const dev of snap.devices ?? []) push("--device", dev);
  for (const group of snap.groupAdd ?? []) push("--group-add", group);
  for (const host of snap.extraHosts ?? []) push("--add-host", host);
  for (const dns of snap.dns ?? []) push("--dns", dns);
  for (const opt of snap.dnsOptions ?? []) push("--dns-option", opt);
  for (const search of snap.dnsSearch ?? []) push("--dns-search", search);

  if (snap.shmSize) push("--shm-size", String(snap.shmSize));
  for (const [key, value] of Object.entries(snap.sysctls ?? {})) push("--sysctl", `${key}=${value}`);
  for (const ulimit of snap.ulimits ?? []) push("--ulimit", ulimitValue(ulimit));
  if (snap.runtime) push("--runtime", snap.runtime);
  if (snap.pidsLimit !== null && snap.pidsLimit !== undefined) push("--pids-limit", String(snap.pidsLimit));
  if (snap.memory) push("--memory", String(snap.memory));
  if (snap.memorySwap) push("--memory-swap", String(snap.memorySwap));
  if (snap.nanoCpus) push("--cpus", String(snap.nanoCpus / 1e9));
  if (snap.cpuPeriod) push("--cpu-period", String(snap.cpuPeriod));
  if (snap.cpuQuota) push("--cpu-quota", String(snap.cpuQuota));
  if (snap.cpusetCpus) push("--cpuset-cpus", snap.cpusetCpus);
  if (snap.cpusetMems) push("--cpuset-mems", snap.cpusetMems);
  if (snap.oomKillDisable) push("--oom-kill-disable");
  if (snap.oomScoreAdj !== 0) push("--oom-score-adj", String(snap.oomScoreAdj));
  if (snap.cgroupnsMode && snap.cgroupnsMode !== "private") push("--cgroupns", snap.cgroupnsMode);
  if (snap.ipcMode && snap.ipcMode !== "private") push("--ipc", snap.ipcMode);
  if (snap.pidMode && snap.pidMode !== "private") push("--pid", snap.pidMode);
  if (snap.utsMode && snap.utsMode !== "private") push("--uts", snap.utsMode);

  if (snap.logConfig?.type) {
    push("--log-driver", snap.logConfig.type);
    for (const [key, value] of Object.entries(snap.logConfig.opts ?? {})) push("--log-opt", `${key}=${value}`);
  }

  const hc = snap.healthcheck;
  if (hc) {
    if (Array.isArray(hc.test) && hc.test[0] === "NONE") push("--no-healthcheck");
    if (Array.isArray(hc.test) && hc.test.length > 1) push("--health-cmd", hc.test.slice(1).join(" "));
    if (hc.interval) push("--health-interval", nsToDuration(hc.interval));
    if (hc.timeout) push("--health-timeout", nsToDuration(hc.timeout));
    if (hc.retries) push("--health-retries", String(hc.retries));
    if (hc.startPeriod) push("--health-start-period", nsToDuration(hc.startPeriod));
  }

  const cmd = Array.isArray(snap.cmd) ? snap.cmd : [];
  return { args, cmd };
}

module.exports = {
  nsToDuration,
  inspectToSnapshot,
  findUnsupported,
  snapshotToRunArgs,
  UNSUPPORTED_PREFIX,
};
