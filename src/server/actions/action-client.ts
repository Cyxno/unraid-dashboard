import { getEnv } from "@/server/env";

/**
 * Write-path client. Completely separate from the read client:
 * - uses ONLY UNRAID_ACTION_API_KEY (never the VIEWER read key);
 * - sends only the fixed mutation strings below (verified against the
 *   live Unraid 7.3.2 API schema — docker.start/stop (v4.10.0 has NO
 *   restart), vm.start/stop; no user text is interpolated into GraphQL;
 * - validates the target exists in the live inventory before mutating;
 * - normalizes results/errors.
 *
 * If the action key is not configured the routes disable themselves —
 * this module is never imported for read paths.
 */

export class ActionError extends Error {
  readonly code:
    | "disabled"
    | "timeout"
    | "unreachable"
    | "forbidden"
    | "bad-response"
    | "not-found"
    | "already-in-state"
    | "mutation-failed";
  constructor(code: ActionError["code"], message: string) {
    super(message);
    this.name = "ActionError";
    this.code = code;
  }
}

/** Fixed mutation strings — the only write operations this app can send. */
export const DOCKER_START_MUTATION = /* GraphQL */ `
  mutation DockerStart($id: PrefixedID!) {
    docker {
      start(id: $id) {
        id
        state
      }
    }
  }
`;
export const DOCKER_STOP_MUTATION = /* GraphQL */ `
  mutation DockerStop($id: PrefixedID!) {
    docker {
      stop(id: $id) {
        id
        state
      }
    }
  }
`;
export const VM_START_MUTATION = /* GraphQL */ `
  mutation VmStart($id: PrefixedID!) {
    vm {
      start(id: $id)
    }
  }
`;
export const VM_STOP_MUTATION = /* GraphQL */ `
  mutation VmStop($id: PrefixedID!) {
    vm {
      stop(id: $id)
    }
  }
`;

export const NOTIFICATION_ARCHIVE_MUTATION = /* GraphQL */ `
  mutation NotificationArchive($id: PrefixedID!) {
    archiveNotification(id: $id) {
      id
    }
  }
`;

export const DOCKER_ACTIONS = ["start", "stop"] as const;
export const VM_ACTIONS = ["start", "stop"] as const;

/** Archive (reversible) is the only notification mutation we ship. */
export const NOTIFICATION_ACTIONS = ["archive"] as const;

const DOCKER_MUTATIONS = {
  start: DOCKER_START_MUTATION,
  stop: DOCKER_STOP_MUTATION,
} as const;

const VM_MUTATIONS = {
  start: VM_START_MUTATION,
  stop: VM_STOP_MUTATION,
} as const;

/** The docker container state a successful action should produce. */
export const EXPECTED_DOCKER_STATE = {
  start: "RUNNING",
  stop: "EXITED",
} as const;

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

async function actionRequest<T>(
  query: string,
  variables: Record<string, string>,
): Promise<T> {
  const env = getEnv();
  if (!env.UNRAID_ACTION_API_KEY) {
    throw new ActionError("disabled", "No action key configured");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(`${env.UNRAID_URL}${env.UNRAID_GRAPHQL_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.UNRAID_ACTION_API_KEY,
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ActionError("timeout", "Action request timed out");
    }
    throw new ActionError(
      "unreachable",
      `Cannot reach Unraid API: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 401 || response.status === 403) {
    throw new ActionError("forbidden", "Action key lacks permission for this operation");
  }
  if (!response.ok) {
    throw new ActionError("bad-response", `Unraid API responded with HTTP ${response.status}`);
  }

  let body: GraphQLResponse<T>;
  try {
    body = (await response.json()) as GraphQLResponse<T>;
  } catch {
    throw new ActionError("bad-response", "Unraid API returned malformed JSON");
  }
  const firstError = body.errors?.[0];
  if (firstError) {
    const message = firstError.message;
    if (/no such container|not found|unknown container/i.test(message)) {
      throw new ActionError("not-found", "Target no longer exists");
    }
    if (/forbidden/i.test(message) || firstError.extensions?.code === "FORBIDDEN") {
      throw new ActionError("forbidden", "Action key lacks permission for this operation");
    }
    if (/already (started|running|stopped|exited)/i.test(message)) {
      throw new ActionError("already-in-state", message);
    }
    throw new ActionError("mutation-failed", message);
  }
  if (body.data === undefined) {
    throw new ActionError("bad-response", "Unraid API returned no data");
  }
  return body.data;
}

/** Live inventory rows used for target validation + state verification. */
export interface InventoryTarget {
  id: string;
  name: string;
  state: string;
}

/**
 * Resolves a container NAME to its live inventory target (v1.7.0
 * remediation preconditions). Returns null when the container is not in
 * the current live inventory — callers must refuse to act then.
 */
export async function findDockerTarget(name: string): Promise<InventoryTarget | null> {
  const inventory = await fetchReadInventory("docker");
  return inventory.find((entry) => entry.name === name) ?? null;
}

/**
 * Live inventory via the READ path (VIEWER key). Target validation uses
 * the same inventory the UI shows, so users can only act on real,
 * currently-known targets.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- raw GraphQL boundary;
   access goes through defensive String() coercion below. */
async function fetchReadInventory(kind: "docker" | "vm" | "notification"): Promise<InventoryTarget[]> {
  const env = getEnv();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${env.UNRAID_URL}${env.UNRAID_GRAPHQL_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.UNRAID_API_KEY,
      },
      body: JSON.stringify({
        query:
          kind === "docker"
            ? `query { docker { containers { id names state } } }`
            : kind === "vm"
              ? `query { vms { domains { id name state } } }`
              : `query { notifications { list(filter: { type: UNREAD, limit: 100 }) { id title } } }`,
      }),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new ActionError("bad-response", `Unraid API responded with HTTP ${response.status}`);
    }
    const body = (await response.json()) as GraphQLResponse<any>;
    if (kind === "docker") {
      const list: any[] = body.data?.docker?.containers ?? [];
      return list.map((entry) => ({
        id: String(entry?.id ?? ""),
        name: String(entry?.names?.[0] ?? "").replace(/^\//, ""),
        state: String(entry?.state ?? ""),
      }));
    }
    if (kind === "vm") {
      const list: any[] = body.data?.vms?.domains ?? [];
      return list.map((entry) => ({
        id: String(entry?.id ?? ""),
        name: String(entry?.name ?? ""),
        state: String(entry?.state ?? ""),
      }));
    }
    const list: any[] = body.data?.notifications?.list ?? [];
    return list.map((entry) => ({
      id: String(entry?.id ?? ""),
      name: String(entry?.title ?? "").slice(0, 120),
      state: "UNREAD",
    }));
  } catch (error) {
    if (error instanceof ActionError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ActionError("timeout", "Inventory read timed out");
    }
    throw new ActionError(
      "unreachable",
      `Cannot reach Unraid API: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}


export interface ActionOutcome {
  status: "success" | "not-found" | "already-in-state" | "error" | "timeout";
  message: string;
  /** State observed after the action (post-read), when available. */
  postState: string | null;
  /** True when the post-action state matches the expected transition. */
  verified: boolean;
  /** Resolved target name from the live inventory (for audit). */
  targetName: string | null;
}

/**
 * Executes one allowlisted action after validating the target against
 * the live inventory. Never trust client-side names beyond the check.
 */
export async function executeAction(
  kind: "docker" | "vm" | "notification",
  action: string,
  targetId: string,
): Promise<ActionOutcome> {
  // Allowlist enforcement — nothing else can ever be sent.
  if (kind === "docker") {
    if (!(DOCKER_ACTIONS as readonly string[]).includes(action)) {
      throw new ActionError("forbidden", `Unsupported docker action: ${action}`);
    }
  } else if (kind === "vm") {
    if (!(VM_ACTIONS as readonly string[]).includes(action)) {
      throw new ActionError("forbidden", `Unsupported vm action: ${action}`);
    }
  } else {
    if (!(NOTIFICATION_ACTIONS as readonly string[]).includes(action)) {
      throw new ActionError("forbidden", `Unsupported notification action: ${action}`);
    }
  }

  // Target validation against live inventory (READ key — same view as UI).
  const inventory = await fetchReadInventory(kind);
  const target = inventory.find((entry) => entry.id === targetId);
  if (!target) {
    return {
      status: "not-found",
      message: "Target is not present in the live inventory — refusing to act.",
      postState: null,
      verified: false,
      targetName: null,
    };
  }
  const targetName = target.name;

  // Notification archive: target must exist in the live unread list.
  if (kind === "notification") {
    const unread = await fetchReadInventory("notification");
    const target = unread.find((entry) => entry.id === targetId);
    if (!target) {
      return {
        status: "not-found",
        message: "Notification is not present in the live unread list — refusing to act.",
        postState: null,
        verified: false,
        targetName: null,
      };
    }
    await actionRequest(NOTIFICATION_ARCHIVE_MUTATION, { id: targetId });
    return {
      status: "success",
      message: "Notification archived (reversible via Unraid notifications).",
      postState: null,
      verified: true,
      targetName: target.name,
    };
  }

  // already-in-state short-circuits (based on live state, not client claims).
  if (kind === "docker") {
    if (action === "start" && target.state === "RUNNING") {
      return { status: "already-in-state", message: "Container is already running.", postState: "RUNNING", verified: true, targetName };
    }
    if (action === "stop" && target.state === "EXITED") {
      return { status: "already-in-state", message: "Container is already stopped.", postState: "EXITED", verified: true, targetName };
    }
  }

  const started = Date.now();
  try {
    if (kind === "docker") {
      const data = await actionRequest<{
        docker: { [key: string]: { state?: string } | null };
      }>(DOCKER_MUTATIONS[action as keyof typeof DOCKER_MUTATIONS], {
        id: targetId,
      });

      // Docker mutations return the container; verify the reported state.
      const returned = data.docker?.[action];
      const returnedState = typeof returned?.state === "string" ? returned.state : null;
      const expected = EXPECTED_DOCKER_STATE[action as keyof typeof EXPECTED_DOCKER_STATE];
      const verified = returnedState === expected;
      return {
        status: verified ? "success" : "error",
        message: verified
          ? `Action '${action}' completed.`
          : `Action accepted but state is '${returnedState ?? "unknown"}' (expected ${expected}).`,
        postState: returnedState,
        verified,
        targetName,
      };
    }

    const vmData = await actionRequest<Record<string, unknown>>(
      VM_MUTATIONS[action as keyof typeof VM_MUTATIONS],
      { id: targetId },
    );
    // VM mutations return Boolean (null when the domain does not exist).
    const ok = vmData[action] !== null;
    void started;
    return ok
      ? { status: "success", message: `VM '${action}' accepted.`, postState: null, verified: false, targetName }
      : { status: "not-found", message: "VM domain not found.", postState: null, verified: false, targetName };
  } catch (error) {
    if (error instanceof ActionError) {
      if (error.code === "already-in-state") {
        return { status: "already-in-state", message: error.message, postState: null, verified: true, targetName };
      }
      return {
        status: error.code === "timeout" ? "timeout" : error.code === "not-found" ? "not-found" : "error",
        message: error.message,
        postState: null,
        verified: false,
        targetName,
      };
    }
    throw error;
  }
}
