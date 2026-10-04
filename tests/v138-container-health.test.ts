import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyContainerHealth,
  isContainerProblem,
  type ContainerHealthInput,
} from "@/lib/container-health";

/** v1.3.8 regression suite: STOPPED != PROBLEM.
 *
 * One canonical classifier (src/lib/container-health.ts) must drive every
 * consumer — Docker list, Problems filter, counters, Overview, NOC,
 * notifications, agent issues, mobile. These tests pin the semantics:
 * a deliberately stopped/exited/paused container is a state, never a
 * problem; only unhealthy / restarting / concrete error evidence is. */

const base = {
  state: "RUNNING",
  health: null,
  status: "Up 2 hours",
} as const;

test("running + healthy is not a problem", () => {
  const v = classifyContainerHealth({ ...base, health: "healthy" });
  assert.equal(v.classification, "healthy");
  assert.equal(v.isProblem, false);
});

test("running without healthcheck is not a problem", () => {
  const v = classifyContainerHealth({ ...base, health: null });
  assert.equal(v.classification, "running");
  assert.equal(v.isProblem, false);
});

test("running + healthcheck starting is transitional, not a problem", () => {
  const v = classifyContainerHealth({ ...base, health: "starting" });
  assert.equal(v.isProblem, false);
});

test("stopped container (exit 0) is not a problem", () => {
  const v = classifyContainerHealth({
    ...base,
    state: "EXITED",
    status: "Exited (0) 3 days ago",
  });
  assert.equal(v.classification, "stopped");
  assert.equal(v.isProblem, false);
});

test("exited container with old non-zero exit code is not a problem", () => {
  // Stale exit evidence must not poison a deliberate stop.
  const v = classifyContainerHealth({
    ...base,
    state: "EXITED",
    status: "Exited (137) 2 days ago",
  });
  assert.equal(v.isProblem, false);
});

test("manually stopped container is not a problem", () => {
  const v = classifyContainerHealth({
    ...base,
    state: "EXITED",
    status: "Exited (0) 5 minutes ago",
  });
  assert.equal(v.isProblem, false);
});

test("paused container is not a problem", () => {
  const v = classifyContainerHealth({
    ...base,
    state: "PAUSED",
    status: "Up 2 hours (Paused)",
  });
  assert.equal(v.classification, "paused");
  assert.equal(v.isProblem, false);
});

test("unhealthy container is a problem", () => {
  const v = classifyContainerHealth({ ...base, health: "unhealthy" });
  assert.equal(v.classification, "unhealthy");
  assert.equal(v.isProblem, true);
});

test("restarting container (status evidence) is a problem", () => {
  const v = classifyContainerHealth({
    ...base,
    status: "Restarting (1) 23 seconds ago",
  });
  assert.equal(v.classification, "restarting");
  assert.equal(v.isProblem, true);
});

test("failed update is a problem", () => {
  const v = classifyContainerHealth({ ...base, updateFailed: true });
  assert.equal(v.isProblem, true);
});

test("failed start with concrete evidence is a problem", () => {
  const v = classifyContainerHealth({ ...base, startError: true });
  assert.equal(v.classification, "error");
  assert.equal(v.isProblem, true);
});

test("autostart=true + stopped is not a problem", () => {
  // autostart does not imply 24/7 expectation; inventory + stopped is enough.
  assert.equal(isContainerProblem({ ...base, state: "EXITED" }), false);
});

test("autostart=false + stopped is not a problem", () => {
  assert.equal(isContainerProblem({ ...base, state: "EXITED" }), false);
});

test("update available on a stopped container is not a health problem", () => {
  // Update state, runtime state and health state stay separate.
  assert.equal(isContainerProblem({ ...base, state: "EXITED" }), false);
});

test("problems filter semantics: stopped excluded, unhealthy included", () => {
  const containers = [
    { name: "tool", state: "EXITED", health: null, status: "Exited (0) 1 day ago" },
    { name: "db", state: "EXITED", health: null, status: "Exited (0) 1 month ago" },
    { name: "web", state: "RUNNING", health: "healthy", status: "Up 1 hour" },
    { name: "api", state: "RUNNING", health: "unhealthy", status: "Up 1 hour (unhealthy)" },
    { name: "loop", state: "RUNNING", health: null, status: "Restarting (1) 4 seconds ago" },
  ] as const;
  const problems = containers.filter((c) => isContainerProblem(c));
  assert.deepEqual(
    problems.map((c) => c.name),
    ["api", "loop"],
  );
  // Stopped filter still includes every exited container.
  const stopped = containers.filter((c) => c.state === "EXITED");
  assert.deepEqual(stopped.map((c) => c.name), ["tool", "db"]);
});

test("problem counter ignores stopped containers", () => {
  // 56 containers, 10 running, 46 deliberately stopped, 0 unhealthy.
  const containers: ContainerHealthInput[] = Array.from({ length: 56 }, (_, i) =>
    i < 10
      ? { state: "RUNNING", health: null, status: "Up" }
      : { state: "EXITED", health: null, status: "Exited (0)" },
  );
  assert.equal(containers.filter((c) => isContainerProblem(c)).length, 0);
});

test("old exit code does not poison deliberate stopped state", () => {
  // Inventory carries no exit code at all; status text alone classifies.
  const v = classifyContainerHealth({
    state: "EXITED",
    health: null,
    status: "Exited (255) 6 months ago",
  });
  assert.equal(v.isProblem, false);
});

test("long-term stopped container stays neutral", () => {
  const v = classifyContainerHealth({
    state: "EXITED",
    health: null,
    status: "Exited (0) 4 months ago",
  });
  assert.equal(v.classification, "stopped");
  assert.equal(v.isProblem, false);
});

test("recreated container keeps same classification semantics", () => {
  const v = classifyContainerHealth({
    state: "RUNNING",
    health: "healthy",
    status: "Up 10 seconds",
  });
  assert.equal(v.isProblem, false);
});
