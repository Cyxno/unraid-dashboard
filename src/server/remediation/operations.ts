import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getEnvSafe } from "@/server/env";
import type { OperationRecord, OperationState, RemediationActionType } from "@/lib/api-types";

/**
 * Operation registry (v1.7.0 Fase 7/8/21).
 *
 * One persisted JSON file under AUDIT_DIR records every remediation
 * operation with its EXPLICIT lifecycle: pending → executing → verifying
 * → succeeded/failed/timed-out/rolled-back/cancelled. A successful HTTP
 * response never implies success — the state only advances to succeeded
 * after the effect was OBSERVED (post-action verification).
 *
 * The registry is the central concurrency model (Fase 10): one entity
 * holds at most one active operation, so an update running on a container
 * blocks stop/start and vice versa. It survives frontend reloads and
 * container restarts (persisted), with bounded retention.
 */

const OPERATIONS_MAX = 100;
/** Every operation is bounded; the executor re-reads real state after. */
export const OPERATION_TIMEOUT_MS = 120_000;
/** Diagnostic operations are inherently quick. */
export const DIAGNOSTIC_TIMEOUT_MS = 30_000;

const ACTIVE_STATES = new Set<OperationState>(["pending", "executing", "verifying"]);

interface OperationsState {
  version: 1;
  /** id → operation, newest last. */
  operations: Record<string, OperationRecord>;
}

const globalStore = globalThis as unknown as {
  __remediationOperations?: OperationsState;
  __operationsSaveQueued?: boolean;
};

function emptyState(): OperationsState {
  return { version: 1, operations: {} };
}

export function operationsStateFilePath(): string {
  return join(getEnvSafe().AUDIT_DIR, "operations-state.json");
}

function loadState(): OperationsState {
  if (globalStore.__remediationOperations) return globalStore.__remediationOperations;
  globalStore.__remediationOperations = emptyState();
  return globalStore.__remediationOperations;
}

function isValidOperation(value: unknown): value is OperationRecord {
  if (!value || typeof value !== "object") return false;
  const candidate = value as OperationRecord;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.entity === "string" &&
    typeof candidate.operation === "string" &&
    typeof candidate.state === "string" &&
    typeof candidate.startedAt === "string" &&
    Array.isArray(candidate.timeline)
  );
}

/** Boot-safe hydration — call before the first registry read in a route. */
export async function ensureOperationsState(): Promise<OperationsState> {
  if (globalStore.__remediationOperations) return globalStore.__remediationOperations;
  try {
    const raw = JSON.parse(await readFile(operationsStateFilePath(), "utf8")) as Partial<OperationsState>;
    const operations: Record<string, OperationRecord> = {};
    for (const [id, operation] of Object.entries(raw.operations ?? {})) {
      if (isValidOperation(operation)) operations[id] = operation;
    }
    // Operations that were mid-flight when the process died are not
    // silently green: they become failed with an honest note (the real
    // effect is re-read from live state by the next verification pass).
    for (const operation of Object.values(operations)) {
      if (ACTIVE_STATES.has(operation.state)) {
        operation.state = "failed";
        operation.updatedAt = new Date().toISOString();
        operation.message = "Interrupted by restart — actual state was re-read on boot.";
        operation.timeline.push({
          at: operation.updatedAt,
          event: "operation interrupted by restart",
          detail: "recovery re-read the actual system state",
        });
      }
    }
    globalStore.__remediationOperations = { version: 1, operations };
  } catch {
    globalStore.__remediationOperations = emptyState();
  }
  return globalStore.__remediationOperations;
}

function scheduleSave(): void {
  if (globalStore.__operationsSaveQueued) return;
  globalStore.__operationsSaveQueued = true;
  setTimeout(() => {
    globalStore.__operationsSaveQueued = false;
    void saveNow();
  }, 250).unref?.();
}

async function saveNow(): Promise<void> {
  const state = loadState();
  try {
    await mkdir(getEnvSafe().AUDIT_DIR, { recursive: true });
    const temp = `${operationsStateFilePath()}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, operationsStateFilePath());
  } catch (error) {
    console.error("[operations] save failed:", error instanceof Error ? error.message : error);
  }
}

/** Test hook. */
export function resetOperationsState(): void {
  globalStore.__remediationOperations = undefined;
}

export function newOperationId(now: number): string {
  return `op${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Unfinished operation on the entity, if any (Fase 10 conflict model). */
export function activeOperationFor(entity: string): OperationRecord | null {
  const state = loadState();
  let newest: OperationRecord | null = null;
  for (const operation of Object.values(state.operations)) {
    if (operation.entity === entity && ACTIVE_STATES.has(operation.state)) {
      if (!newest || Date.parse(operation.startedAt) > Date.parse(newest.startedAt)) newest = operation;
    }
  }
  // Expired operations are not locks: apply the timeout honestly.
  if (newest && newest.timeoutAt && Date.now() > Date.parse(newest.timeoutAt)) {
    transitionOperation(newest.id, "timed-out", "Operation exceeded its time bound — system state was re-read instead of assumed.");
    newest = null;
  }
  return newest;
}

/** Conflicting-operation check used by preconditions (Fase 10). */
export function conflictFor(entity: string, operation: RemediationActionType): string | null {
  const active = activeOperationFor(entity);
  if (!active) return null;
  const updating = active.operation === "verified-update-retry";
  const mutating = operation === "docker-start" || operation === "docker-stop" || operation === "verified-update-retry";
  if (updating && mutating) return `An update is ${active.state} on this container — lifecycle actions are blocked until it finishes.`;
  if (mutating) return `Another operation (${active.operation}) is ${active.state} on this entity.`;
  return null;
}

export function beginOperation(input: {
  entity: string;
  operation: RemediationActionType;
  incidentId: string | null;
  actor: string;
  timeoutMs?: number;
  traceId?: string | null;
}): OperationRecord {
  const now = Date.now();
  const record: OperationRecord = {
    id: newOperationId(now),
    entity: input.entity,
    operation: input.operation,
    incidentId: input.incidentId,
    actor: input.actor,
    state: "pending",
    startedAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    timeoutAt: new Date(now + (input.timeoutMs ?? OPERATION_TIMEOUT_MS)).toISOString(),
    traceId: input.traceId ?? null,
    message: null,
    timeline: [],
  };
  const state = loadState();
  state.operations[record.id] = record;
  // Bounded retention: drop the oldest terminal operations.
  const all = Object.values(state.operations).sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  if (all.length > OPERATIONS_MAX) {
    for (const old of all.slice(0, all.length - OPERATIONS_MAX)) {
      if (!ACTIVE_STATES.has(old.state)) delete state.operations[old.id];
    }
  }
  scheduleSave();
  return record;
}

function getOperation(id: string): OperationRecord | null {
  return loadState().operations[id] ?? null;
}

/** Appends a timeline event to an operation (bounded). */
export function operationEvent(id: string, event: string, detail?: string | null): void {
  const operation = getOperation(id);
  if (!operation) return;
  operation.timeline.unshift({ at: new Date().toISOString(), event, detail: detail ?? null });
  if (operation.timeline.length > 20) operation.timeline.length = 20;
}

/**
 * Explicit state transition (Fase 8). Only the legal transitions below
 * exist; anything else is refused so a green check can never be painted
 * on by an accidental double call.
 */
const LEGAL: Record<OperationState, OperationState[]> = {
  pending: ["executing", "verifying", "cancelled", "failed"],
  executing: ["verifying", "failed", "timed-out", "cancelled"],
  verifying: ["succeeded", "failed", "timed-out", "rolled-back"],
  succeeded: [],
  failed: [],
  "timed-out": [],
  "rolled-back": [],
  cancelled: [],
};

export function transitionOperation(
  id: string,
  state: OperationState,
  message?: string | null,
): OperationRecord | null {
  const operation = getOperation(id);
  if (!operation) return null;
  if (!LEGAL[operation.state].includes(state)) return operation;
  operation.state = state;
  operation.updatedAt = new Date().toISOString();
  operation.message = message ?? operation.message;
  if (message) operationEvent(id, `state → ${state}`, message);
  else operationEvent(id, `state → ${state}`);
  scheduleSave();
  return operation;
}

/** Recent operations for an entity (newest first, bounded). */
export function operationsForEntity(entity: string, limit = 10): OperationRecord[] {
  return Object.values(loadState().operations)
    .filter((operation) => operation.entity === entity)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, limit);
}

export function getOperationById(id: string): OperationRecord | null {
  return loadState().operations[id] ?? null;
}

export function operationsForIncident(incidentId: string, limit = 10): OperationRecord[] {
  return Object.values(loadState().operations)
    .filter((operation) => operation.incidentId === incidentId)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, limit);
}
