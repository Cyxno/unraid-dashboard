/**
 * Compose adapter (v0.7.11): pure functies voor label-parsing, path-
 * allowlist-validatie en argv-constructie. De helper bevat alleen de
 * Docker-socket en READ-ONLY mounts van de toegestane compose-roots —
 * geen shell, geen request-supplied paden, argv-arrays only.
 */

const COMPOSE_LABEL_PREFIX = "com.docker.compose.";

/** Parses compose management labels from a container's label set. */
function parseComposeLabels(labels = {}) {
  const project = labels["com.docker.compose.project"] ?? null;
  const service = labels["com.docker.compose.service"] ?? null;
  const workdir = labels["com.docker.compose.project.working_dir"] ?? null;
  const configFilesRaw = labels["com.docker.compose.project.config_files"] ?? null;
  const configFiles = configFilesRaw
    ? String(configFilesRaw).split(",").map((f) => f.trim()).filter(Boolean)
    : [];
  if (!project || !service || !workdir) return null;
  return { project, service, workdir, configFiles };
}

/** Realpath without following beyond existence — best effort (sync caller). */
function isInsideRoot(resolvedPath, allowedRoot) {
  const rootWithSep = allowedRoot.endsWith("/") ? allowedRoot : `${allowedRoot}/`;
  return resolvedPath === allowedRoot || resolvedPath.startsWith(rootWithSep);
}

/**
 * Valideert een compose working_dir tegen de allowlist. Canonicaliseert
 * en verifieert dat het pad binnen een toegestane root blijft.
 * Returns { ok: true, canonical } | { ok: false, reason }.
 */
function validateAllowedPath(workdir, allowedRoots) {
  if (!workdir || typeof workdir !== "string") return { ok: false, reason: "missing working_dir" };
  if (workdir.includes("..")) return { ok: false, reason: "path traversal rejected" };
  const canonical = workdir.replace(/\/+$/, "") || "/";
  const roots = allowedRoots.filter((r) => typeof r === "string" && r.length > 0);
  if (roots.length === 0) return { ok: false, reason: "no compose roots allowlisted" };
  for (const root of roots) {
    const rootCanonical = root.replace(/\/+$/, "") || "/";
    if (isInsideRoot(canonical, rootCanonical)) {
      return { ok: true, canonical, root: rootCanonical };
    }
  }
  return { ok: false, reason: `working_dir outside allowed roots: ${canonical}` };
}

/** Valideert alle config_files: binnen de working_dir of een allowed root. */
function validateConfigFiles(configFiles, workdir, allowedRoots) {
  for (const file of configFiles) {
    if (file.includes("..")) return { ok: false, reason: "path traversal in config file" };
    if (!file.startsWith("/") && !file.startsWith("./")) {
      // relatief pad — composelost op t.o.v. working_dir; dat is veilig.
      continue;
    }
    const canonical = file.replace(/\/+$/, "");
    const inRoot = allowedRoots.some((root) => {
      const rc = root.replace(/\/+$/, "") || "/";
      return isInsideRoot(canonical, rc) || canonical.startsWith(`${workdir}/`) || canonical === workdir;
    });
    if (!inRoot && !canonical.startsWith(workdir)) {
      return { ok: false, reason: `config file outside allowed roots: ${file}` };
    }
  }
  return { ok: true };
}

/**
 * Bouwt de compose argv voor een gescopede service-actie.
 * action: "pull" | "up" | "config" | "config-json"
 * Alle onderdelen komen uit gevalideerde inventory — nooit uit requests.
 */
function composeArgs({ project, workdir, configFiles, service }, action) {
  const args = ["compose", "--project-name", project, "--project-directory", workdir];
  for (const file of configFiles) args.push("--file", file);
  if (action === "pull") {
    args.push("pull", service);
  } else if (action === "up") {
    args.push("up", "-d", "--no-deps", service);
  } else if (action === "config") {
    args.push("config", "--services");
  } else if (action === "config-json") {
    args.push("config", "--format", "json");
  }
  return args;
}

/** Sibling services van hetzelfde project (exclusief de target). */
function siblingServices(containers, project, excludeService) {
  return containers
    .filter(
      (c) =>
        c.labels["com.docker.compose.project"] === project &&
        c.labels["com.docker.compose.service"] !== excludeService,
    )
    .map((c) => ({ name: c.name, service: c.labels["com.docker.compose.service"] ?? null, state: c.state }));
}

/**
 * Parseert de uitvoer van `docker compose config --format json` tot een
 * compacte dependency-grafiek. Puur — unit-getest. depends_on komt alleen
 * uit de compose-configuratie; service-namen worden nooit geraden.
 * Short syntax (lijst) én long syntax (object met condition) worden
 * ondersteund. Onbekende vormen worden genegeerd (no inventing).
 */
function parseComposeConfig(configJson) {
  const servicesRaw = configJson && typeof configJson === "object" ? configJson.services : null;
  if (!servicesRaw || typeof servicesRaw !== "object") {
    return { ok: false, reason: "compose config has no services object" };
  }
  const services = [];
  const dependsOn = {};
  for (const [service, def] of Object.entries(servicesRaw)) {
    if (!def || typeof def !== "object") continue;
    services.push(service);
    const raw = def.depends_on;
    const deps = [];
    if (Array.isArray(raw)) {
      for (const dep of raw) if (typeof dep === "string") deps.push(dep);
    } else if (raw && typeof raw === "object") {
      for (const dep of Object.keys(raw)) if (typeof dep === "string") deps.push(dep);
    }
    dependsOn[service] = deps;
  }
  if (services.length === 0) {
    return { ok: false, reason: "compose config defines no services" };
  }
  return { ok: true, services, dependsOn };
}

/**
 * Topologische volgorde over depends_on (dependencies eerst). Deterministiek
 * (alfabetisch binnen gelijke niveaus). Returned null + reden bij cyclus of
 * een edge naar een service zonder draaiende container — dan is de graaf
 * ambigu en weigeren we project-updates.
 */
function topologicalOrder(services, dependsOn) {
  const known = new Set(services);
  for (const [service, deps] of Object.entries(dependsOn)) {
    if (!known.has(service)) continue;
    for (const dep of deps) {
      if (!known.has(dep)) {
        return { ok: false, reason: `service "${service}" depends on "${dep}", which is not a running service of this project` };
      }
    }
  }
  const remaining = new Set(services);
  const placed = new Set();
  const order = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((service) => (dependsOn[service] ?? []).every((dep) => !known.has(dep) || placed.has(dep)))
      .sort();
    if (ready.length === 0) {
      return { ok: false, reason: `dependency cycle between: ${[...remaining].sort().join(", ")}` };
    }
    for (const service of ready) {
      order.push(service);
      placed.add(service);
      remaining.delete(service);
    }
  }
  return { ok: true, order };
}

module.exports = {
  parseComposeLabels,
  isInsideRoot,
  validateAllowedPath,
  validateConfigFiles,
  composeArgs,
  siblingServices,
  parseComposeConfig,
  topologicalOrder,
};
