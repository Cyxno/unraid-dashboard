import { getHelperStatus } from "@/server/update/helper-client";
import { normalizeActionCapabilities, type RawActionStatus } from "@/lib/action-capabilities";

/**
 * Normalized automation eligibility by workflow (v0.9.11). Single source
 * of truth for capabilities: the same normalized action-capability model
 * the Docker page/detail/Operations/Settings use, plus live helper
 * health for the update workflow. Never cached — key removal flips
 * eligibility on the next poll with no stale "Ready" state.
 */

export type AutomationWorkflow = "update-helper" | "lifecycle-start" | "lifecycle-stop" | "restart";

export interface WorkflowEligibility {
  workflow: AutomationWorkflow;
  eligible: boolean;
  blockers: string[];
  requiredCapabilities: string[];
  availableCapabilities: string[];
}

export interface AutomationCapabilityContext {
  computedAt: string;
  workflows: WorkflowEligibility[];
}

async function rawActionStatus(): Promise<RawActionStatus> {
  // Read the authoritative capability facts directly (server-side) —
  // same facts /api/actions/status serves, without an HTTP hop.
  const [{ areActionsEnabled, getEnv }, { DOCKER_ACTIONS }] = await Promise.all([
    import("@/server/env"),
    import("@/server/actions/action-client"),
  ]);
  const env = getEnv();
  const enabled = areActionsEnabled();
  return {
    enabled,
    reason: enabled
      ? null
      : env.ENABLE_ACTIONS
        ? "Action key is not configured (UNRAID_ACTION_API_KEY missing)."
        : "ENABLE_ACTIONS is not enabled.",
    docker: enabled ? [...DOCKER_ACTIONS] : [],
  };
}

export async function automationCapabilityContext(): Promise<AutomationCapabilityContext> {
  const [raw, helper] = await Promise.all([
    rawActionStatus(),
    getHelperStatus().catch(() => null),
  ]);
  const caps = normalizeActionCapabilities(raw);
  const helperAvailable = helper?.reachable === true;

  const workflows: WorkflowEligibility[] = [
    {
      workflow: "update-helper",
      requiredCapabilities: ["update-helper"],
      availableCapabilities: helperAvailable ? ["update-helper"] : [],
      eligible: helperAvailable,
      blockers: helperAvailable ? [] : ["Update helper offline"],
    },
    {
      workflow: "lifecycle-start",
      requiredCapabilities: ["docker:start"],
      availableCapabilities: caps.docker.start ? ["docker:start"] : [],
      eligible: caps.docker.start,
      blockers: caps.docker.start ? [] : ["Docker start capability unavailable"],
    },
    {
      workflow: "lifecycle-stop",
      requiredCapabilities: ["docker:stop"],
      availableCapabilities: caps.docker.stop ? ["docker:stop"] : [],
      eligible: caps.docker.stop,
      blockers: caps.docker.stop ? [] : ["Docker stop capability unavailable"],
    },
    {
      workflow: "restart",
      requiredCapabilities: ["docker:restart"],
      availableCapabilities: [],
      // Permanently blocked: the verified Unraid API exposes no restart.
      eligible: false,
      blockers: ["Restart unsupported by verified Unraid API"],
    },
  ];

  return { computedAt: new Date().toISOString(), workflows };
}
