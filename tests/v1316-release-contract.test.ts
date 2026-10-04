import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

process.env.UNRAID_URL ??= "http://127.0.0.1:442";
process.env.UNRAID_API_KEY ??= "k";

import {
  buildManagedContainer,
  canonicalUpdateState,
  type ContainerFacts,
} from "../src/server/docker/model";
import { isContainerProblem } from "../src/lib/container-health";
import { CONTAINER_CPU_QUERY, CONTAINER_MEMORY_USED_QUERY, CADVISOR_DOCKER_SELECTOR } from "../src/server/prometheus/queries";
import { helperInventorySchema, describeInventoryIssues } from "../src/server/docker/helper-contract";
import { dockerIssues } from "../src/server/agent/issues";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const helperSource = fs.readFileSync(path.join(ROOT, "helper", "server.js"), "utf8");
const changelog = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "generated", "changelog.json"), "utf8"));

/* ---- Fase 9: version contract ------------------------------------------- */

describe("Fase 9: version contract — dashboard = helper = changelog", () => {
  test("package.json, helper HELPER_VERSION and changelog latest all match", () => {
    const match = helperSource.match(/const HELPER_VERSION = "([^"]+)"/);
    assert.ok(match, "HELPER_VERSION constant must exist in helper/server.js");
    assert.equal(match[1], pkg.version, "helper internal version must equal package.json version");
    assert.equal(changelog.latestVersion, `v${pkg.version}`, "changelog latest must match package.json");
    // changelog contains an entry for the exact version
    assert.ok(changelog.releases.some((r: { version: string }) => r.version === `v${pkg.version}`));
  });
});

/* ---- Fase 8/16: golden inventory fixture through the real contract ------ */

const golden = {
  version: "1.3.16",
  containers: [
    {
      id: "0".repeat(12), idShort: "0".repeat(12), idFull: "0".repeat(64),
      name: "web", image: "registry.example/web:1.0", state: "running", status: "Up 1 hour (healthy)",
      health: "healthy", imageId: "sha256:web", repoDigests: ["registry.example/web@sha256:aaaa"],
      labels: { "net.unraid.docker.managed": "dockerman" }, networks: [], volumeSources: [],
      created: "2026-10-04T00:00:00Z", unsupported: [], externallyManaged: false, snapshotPresent: true,
    },
    {
      id: "1".repeat(12), idShort: "1".repeat(12), idFull: "1".repeat(64),
      name: "db", image: "registry.example/db:2.0", state: "EXITED", status: "Exited (0) 1 day ago",
      health: null, imageId: "sha256:db", repoDigests: ["registry.example/db@sha256:bbbb"],
      labels: {}, networks: [], volumeSources: [], created: null, unsupported: [], snapshotPresent: false,
    },
    {
      id: "2".repeat(12), idShort: "2".repeat(12), idFull: "2".repeat(64),
      name: "sick", image: "registry.example/sick:3.0", state: "running", status: "Up 5 min (unhealthy)",
      health: "unhealthy", imageId: "sha256:sick", repoDigests: ["registry.example/sick@sha256:cccc"],
      labels: {}, networks: [], volumeSources: [], created: null, snapshotPresent: false,
    },
    {
      id: "3".repeat(12), name: "pipeline", image: "tornscope-api:latest", state: "running", status: "Up",
      health: null, imageId: "sha256:pipe", repoDigests: [],
      labels: { "com.docker.compose.project": "tornscope", "com.docker.compose.service": "api" },
    },
    {
      id: "4".repeat(12), name: "private", image: "ghcr.example/private:1", state: "running", status: "Up",
      health: null, imageId: "sha256:priv", repoDigests: ["ghcr.example/private@sha256:dddd"],
      labels: {},
    },
  ] as Array<Record<string, unknown>>,
  storage: { mode: "image-file", source: null },
};

describe("Fase 7/8/16: helper → dashboard contract on the golden fixture", () => {
  test("golden fixture passes the runtime schema (additive extra fields tolerated)", () => {
    const withExtra = { ...golden, futureField: { anything: true }, containers: golden.containers.map((c) => ({ ...c, brandNewField: 1 })) };
    const parsed = helperInventorySchema.safeParse(withExtra);
    if (!parsed.success) assert.fail(`fixture must pass: ${describeInventoryIssues(parsed.error)}`);
  });

  test("missing required field fails the contract", () => {
    const broken = { ...golden, containers: golden.containers.map((c, i) => (i === 0 ? { ...c, name: undefined } : c)) };
    const parsed = helperInventorySchema.safeParse(broken);
    assert.equal(parsed.success, false);
  });

  test("wrong type fails the contract", () => {
    const broken = { ...golden, containers: [{ ...golden.containers[0], repoDigests: "not-an-array" }] };
    assert.equal(helperInventorySchema.safeParse(broken).success, false);
  });

  test("classification through the real dashboard model: all states on one fixture", () => {
    const facts = helperInventorySchema.parse(golden).containers as unknown as ContainerFacts[];
    const raw: Record<string, Parameters<typeof canonicalUpdateState>[1]> = {
      web: { kind: "digest", remoteDigest: "sha256:aaaa" }, // up to date
      db: { kind: "digest", remoteDigest: "sha256:newdb" }, // stopped + update
      sick: { kind: "auth_required", reason: "denied" },
      pipeline: { kind: "not_found", reason: "404" },
      private: { kind: "auth_required", reason: "private" },
    };
    const built = facts.map((f) => ({
      name: f.name,
      model: buildManagedContainer({ facts: f, customDeployContainers: [], extraHighRisk: [], rawCheck: raw[f.name] ?? null, checkedAt: "now" }),
    }));
    const by = Object.fromEntries(built.map((b) => [b.name, b.model])) as Record<string, (typeof built)[number]["model"]>;
    // update states
    assert.equal(by.web!.update_status, "UP_TO_DATE");
    assert.equal(by.pipeline!.update_status, "LOCAL_BUILD"); // pipeline-owned observes as local
    assert.equal(by.pipeline!.update_available, false);
    assert.equal(by.private!.update_status, "AUTH_REQUIRED");
    // stopped semantics (v1.3.8): stopped + update stays a neutral state
    assert.equal(by.db!.update_available, true);
    assert.equal(isContainerProblem({ state: "EXITED", health: null, status: "Exited (0)" }), false);
    // unhealthy stays a problem, independent of update state
    assert.equal(isContainerProblem({ state: "RUNNING", health: "unhealthy", status: "Up (unhealthy)" }), true);
    // notification contract: only unhealthy containers raise docker issues
    const issues = dockerIssues(facts.map((f) => ({ name: f.name, id: f.id, health: (f as { health?: string | null }).health ?? null, updateAvailable: false, risk: "LOW" as const, managementType: "unraid", cpuPercent: null })));
    assert.deepEqual(issues.map((i) => i.target?.name), ["sick"]);
    // update availability alone never becomes a problem or an alert
    assert.equal(issues.some((i) => i.condition === "container_unhealthy" && i.target?.name !== "sick"), false);
  });
});

/* ---- Fase 19: cAdvisor contract regression ------------------------------ */

describe("Fase 19: cAdvisor query contract", () => {
  test("CPU = rate × 100, no machine_cpu_cores division, no clamp, working_set memory", () => {
    const cpu = CONTAINER_CPU_QUERY();
    assert.match(cpu, /100 \* sum by \(name\) \(rate\(container_cpu_usage_seconds_total/);
    assert.doesNotMatch(cpu, /machine_cpu_cores/);
    assert.doesNotMatch(cpu, /\bclamp|Math\.min\b/);
    assert.match(CONTAINER_MEMORY_USED_QUERY(), /container_memory_working_set_bytes/);
    assert.match(CADVISOR_DOCKER_SELECTOR, /\/docker\/\[0-9a-f\]\{64\}/);
  });
});
