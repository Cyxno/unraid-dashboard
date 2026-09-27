import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseComposeLabels,
  validateAllowedPath,
  validateConfigFiles,
  composeArgs,
} from "../helper/compose";

/** v0.7.11 compose adapter: label parsing, allowlist, argv safety. */

const ROOTS = [
  "/mnt/user/appdata/books-stack",
  "/boot/config/plugins/compose.manager/projects",
  "/mnt/user/appdata/hermes/compose",
];

describe("v0.7.11 compose label parsing", () => {
  it("parsed project/service/workdir/files uit labels", () => {
    const parsed = parseComposeLabels({
      "com.docker.compose.project": "immich",
      "com.docker.compose.service": "immich-server",
      "com.docker.compose.project.working_dir": "/boot/config/plugins/compose.manager/projects/Immich",
      "com.docker.compose.project.config_files": "/boot/config/plugins/compose.manager/projects/Immich/docker-compose.yml,/boot/config/plugins/compose.manager/projects/Immich/docker-compose.override.yml",
    });
    assert.ok(parsed !== null, "labels moeten parseable zijn");
    const p = parsed!;
    assert.equal(p.project, "immich");
    assert.equal(p.service, "immich-server");
    assert.equal(p.configFiles.length, 2);
    // Volgorde behouden: base vóór override.
    assert.match(p.configFiles[0]!, /docker-compose\.yml$/);
    assert.match(p.configFiles[1]!, /override\.yml$/);
  });

  it("geeft null bij ontbrekende compose-labels", () => {
    assert.equal(parseComposeLabels({ "net.unraid.docker.managed": "dockerman" }), null);
    assert.equal(parseComposeLabels({ "com.docker.compose.project": "x" }), null);
  });
});

describe("v0.7.11 compose path allowlist", () => {
  it("accepteert working_dir binnen een allowed root", () => {
    const result = validateAllowedPath("/mnt/user/appdata/books-stack", ROOTS);
    assert.equal(result.ok, true);
  });

  it("accepteert subdirectory van een allowed root", () => {
    const result = validateAllowedPath("/boot/config/plugins/compose.manager/projects/Immich", ROOTS);
    assert.equal(result.ok, true);
  });

  it("weigert pad buiten alle roots", () => {
    const result = validateAllowedPath("/etc", ROOTS);
    assert.equal(result.ok, false);
  });

  it("weigert traversal", () => {
    const result = validateAllowedPath("/mnt/user/appdata/books-stack/../../boot/config", ROOTS);
    assert.equal(result.ok, false);
  });

  it("weigert leeg/missing", () => {
    assert.equal(validateAllowedPath("", ROOTS).ok, false);
    assert.equal(validateAllowedPath(undefined as unknown as string, ROOTS).ok, false);
  });

  it("weigert wanneer er geen roots zijn geconfigureerd (fail closed)", () => {
    assert.equal(validateAllowedPath("/mnt/user/appdata/books-stack", []).ok, false);
  });

  it("root-prefix-truc wordt niet door de prefix-check heengelaten (/books-stack-evil)", () => {
    const result = validateAllowedPath("/mnt/user/appdata/books-stack-evil", ROOTS);
    assert.equal(result.ok, false);
  });
});

describe("v0.7.11 compose config files", () => {
  it("multi-file volgorde is veilig (allemaal binnen root)", () => {
    const result = validateConfigFiles(
      [
        "/boot/config/plugins/compose.manager/projects/Immich/docker-compose.yml",
        "/boot/config/plugins/compose.manager/projects/Immich/docker-compose.override.yml",
      ],
      "/boot/config/plugins/compose.manager/projects/Immich",
      ROOTS,
    );
    assert.equal(result.ok, true);
  });

  it("traversal in een config file wordt geweigerd", () => {
    const result = validateConfigFiles(
      ["../../etc/passwd"],
      "/boot/config/plugins/compose.manager/projects/Immich",
      ROOTS,
    );
    assert.equal(result.ok, false);
  });

  it("config file buiten root wordt geweigerd", () => {
    const result = validateConfigFiles(
      ["/etc/shadow"],
      "/boot/config/plugins/compose.manager/projects/Immich",
      ROOTS,
    );
    assert.equal(result.ok, false);
  });
});

describe("v0.7.11 compose argv constructie", () => {
  const ctx = {
    project: "books-stack",
    workdir: "/mnt/user/appdata/books-stack",
    configFiles: ["/mnt/user/appdata/books-stack/docker-compose.yml"],
    service: "kavita",
  };

  it("pull is gescoped op de service", () => {
    const args = composeArgs(ctx, "pull");
    assert.ok(args.includes("pull"));
    assert.ok(args.includes("kavita"));
    assert.ok(!args.includes("shelfarr"));
  });

  it("up gebruikt -d --no-deps", () => {
    const args = composeArgs(ctx, "up");
    const idx = args.indexOf("up");
    assert.deepEqual(args.slice(idx, idx + 4), ["up", "-d", "--no-deps", "kavita"]);
  });

  it("project-name en files zitten in de argv", () => {
    const args = composeArgs(ctx, "pull");
    const joined = args.join(" ");
    assert.ok(joined.includes("--project-name books-stack"));
    assert.ok(joined.includes("--file /mnt/user/appdata/books-stack/docker-compose.yml"));
  });
});
