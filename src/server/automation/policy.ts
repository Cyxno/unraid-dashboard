/**
 * Automation policy model (v0.8.0) — PURE. No I/O, no clock access: time
 * comes in as an argument so the scheduler is testable with fake time.
 *
 * Pilot auto-update may only run when EVERY gate passes. Defaults are
 * conservative: nothing is eligible without an explicit per-container
 * opt-in, a proven track record, and a verifiable registry update.
 */

export const POLICY_VERSION = "v0.8.0-pilot1";

/* ---- config (operator-controlled, structured, validated at the route) --- */

export interface AutomationConfig {
  /** Master switch. Absent store = disabled. */
  enabled: boolean;
  /** Emergency pause: no NEW auto jobs; an in-flight mutation continues. */
  paused: boolean;
  maintenance: {
    enabled: boolean;
    /** 0=Sunday … 6=Saturday. */
    days: number[];
    /** Start hour (inclusive) in `timezone` local time, 0-23. */
    startHour: number;
    /** End hour (exclusive) in `timezone` local time, 0-23. */
    endHour: number;
    /** IANA timezone; validated with Intl at the config boundary. */
    timezone: string;
  };
  /** Minimum age (hours) a remote digest must have before auto-apply. */
  minUpdateAgeHours: number;
  /** Maximum automatic mutations per maintenance window. */
  maxPerWindow: number;
  /** Cooldown (hours) after a failed/rolled-back auto update. */
  cooldownHours: number;
}

export const DEFAULT_CONFIG: AutomationConfig = {
  enabled: false,
  paused: false,
  maintenance: { enabled: true, days: [0, 1, 2, 3, 4, 5, 6], startHour: 3, endHour: 5, timezone: "UTC" },
  minUpdateAgeHours: 48,
  maxPerWindow: 2,
  cooldownHours: 24,
};

/* ---- per-target automation states (no ambiguous status) ------------------ */

export type AutomationState =
  | "waiting"
  | "eligible"
  | "delayed_by_age"
  | "outside_window"
  | "blocked"
  | "queued"
  | "updating"
  | "verifying"
  | "completed"
  | "rolled_back"
  | "cooldown"
  | "intervention_required";

/* ---- inputs the scheduler assembles per container ------------------------ */

export interface TargetFacts {
  name: string;
  optIn: boolean;
  risk: "LOW" | "MEDIUM" | "HIGH";
  managementType: string;
  updateStrategy: string;
  healthcheckPresent: boolean;
  snapshotPresent: boolean;
  /** Registry check readable for this image (UP_TO_DATE or UPDATE_AVAILABLE). */
  registryVerified: boolean;
  updateAvailable: boolean;
  remoteDigest: string | null;
  /** Age (ms) of the remote digest per the first-seen store; null = unseen. */
  digestAgeMs: number | null;
  manualSuccesses: number;
  rollbackCount: number;
  /** A rollback FAILED for this target and nobody acknowledged yet. */
  interventionRequired: boolean;
  cooldownUntil: string | null;
  pipelineOwned: boolean;
  externallyManaged: boolean;
}

export interface SchedulerContext {
  now: Date;
  config: AutomationConfig;
  helperHealthy: boolean;
  dataDirWritable: boolean;
  /** A dashboard/helper mutation is already running. */
  operationActive: boolean;
  /** Auto mutations already executed in the current window. */
  windowOperationsUsed: number;
  /** Registry checks are degraded (GHCR unreachable) — no auto mutations. */
  registryDegraded: boolean;
  queuedCount: number;
}

/** True when `now` falls inside the configured maintenance window. */
export function isInMaintenanceWindow(now: Date, config: AutomationConfig): { inWindow: boolean; reason: string } {
  const maintenance = config.maintenance;
  if (!maintenance.enabled) return { inWindow: true, reason: "maintenance window disabled — always in window" };
  let local: { day: number; hour: number };
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: maintenance.timezone, weekday: "short", hour: "numeric", hour12: false });
    const parts = formatter.formatToParts(now);
    const weekday = parts.find((part) => part.type === "weekday")?.value ?? "Sun";
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const dayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekday);
    local = { day: dayIndex, hour: hour === 24 ? 0 : hour };
  } catch {
    return { inWindow: false, reason: `invalid maintenance timezone: ${maintenance.timezone}` };
  }
  if (!maintenance.days.includes(local.day)) {
    return { inWindow: false, reason: `day ${local.day} outside maintenance days [${maintenance.days.join(",")}]` };
  }
  const { startHour, endHour } = maintenance;
  if (startHour === endHour) return { inWindow: false, reason: "maintenance window is empty (start == end)" };
  const inHours = startHour < endHour
    ? local.hour >= startHour && local.hour < endHour
    : local.hour >= startHour || local.hour < endHour; // wraps midnight
  if (!inHours) {
    return { inWindow: false, reason: `hour ${local.hour} (${maintenance.timezone}) outside ${String(startHour).padStart(2, "0")}:00–${String(endHour).padStart(2, "0")}:00` };
  }
  return { inWindow: true, reason: "inside maintenance window" };
}

/** Evaluation verdict for ONE container at ONE moment. */
export type EligibilityVerdict =
  | { state: "eligible"; reasons: string[] }
  | { state: "intervention_required" | "cooldown" | "delayed_by_age" | "outside_window" | "blocked"; reasons: string[] };

/**
 * The single authority for whether a container may auto-update NOW.
 * Every refusal carries concrete reasons — the UI shows them verbatim.
 * State precedence: intervention > operator intent > target integrity >
 * cooldown > window/budget > digest age > eligible.
 */
export function evaluateTarget(facts: TargetFacts, context: SchedulerContext): EligibilityVerdict {
  const reasons: string[] = [];
  const window = isInMaintenanceWindow(context.now, context.config);

  // Operator intent.
  if (!facts.optIn) reasons.push("not opted in to pilot auto-update");
  if (context.config.paused) reasons.push("automation paused by operator");
  if (!context.config.enabled) reasons.push("pilot auto-update globally disabled");
  if (context.registryDegraded) reasons.push("registry checks degraded — no auto mutations");

  // Infrastructure.
  if (!context.helperHealthy) reasons.push("update helper unhealthy");
  if (!context.dataDirWritable) reasons.push("/app/data not writable — automation state cannot persist");
  if (context.operationActive) reasons.push("another update operation is active");

  // Target integrity.
  if (facts.interventionRequired) reasons.push("manual intervention required (previous failure not acknowledged)");
  if (facts.pipelineOwned) reasons.push("pipeline-owned — never auto-updated");
  if (facts.externallyManaged) reasons.push("externally managed");
  if (facts.risk !== "LOW") reasons.push(`risk is ${facts.risk} — pilot auto only runs LOW risk`);
  if (!(facts.managementType === "unraid" || facts.managementType === "standalone" || facts.managementType === "compose")) {
    reasons.push(`management type ${facts.managementType} not supported`);
  }
  if (facts.updateStrategy === "local_build") reasons.push("locally built image — updates come from its pipeline");
  if (!facts.healthcheckPresent) reasons.push("no Docker healthcheck");
  if (!facts.snapshotPresent) reasons.push("no rollback snapshot");
  if (!facts.registryVerified) reasons.push("registry update not verifiable");
  if (!facts.updateAvailable) reasons.push("no update available");
  if (facts.manualSuccesses < 3) reasons.push(`only ${facts.manualSuccesses} successful manual update(s) — need 3+`);
  if (facts.rollbackCount > 0) reasons.push(`${facts.rollbackCount} rollback(s) on record`);

  const has = (needle: string) => reasons.some((reason) => reason.includes(needle));

  // 1. Intervention dominates everything.
  if (has("manual intervention required")) return { state: "intervention_required", reasons };

  // 2. Operator intent / infrastructure / integrity → blocked.
  if (
    has("not opted in") || has("paused by operator") || has("globally disabled") || has("registry checks degraded") ||
    has("helper unhealthy") || has("not writable") || has("another update operation") ||
    has("pipeline-owned") || has("externally managed") || has("risk is") || has("management type") ||
    has("locally built") || has("healthcheck") || has("snapshot") || has("registry update not verifiable") ||
    has("no update available") || has("successful manual update") || has("rollback(s) on record")
  ) {
    return { state: "blocked", reasons };
  }

  // 3. Cooldown (target-level, persists across windows).
  if (facts.cooldownUntil && Date.parse(facts.cooldownUntil) > context.now.getTime()) {
    return { state: "cooldown", reasons: [...reasons, `cooldown until ${facts.cooldownUntil}`] };
  }

  // 4. Window / budget.
  if (!window.inWindow) return { state: "outside_window", reasons: [...reasons, window.reason] };
  if (context.windowOperationsUsed >= context.config.maxPerWindow) {
    return { state: "outside_window", reasons: [...reasons, `window budget exhausted (${context.windowOperationsUsed}/${context.config.maxPerWindow})`] };
  }

  // 5. Digest age (not a blocker — a delay).
  if (facts.digestAgeMs === null || facts.digestAgeMs < context.config.minUpdateAgeHours * 3_600_000) {
    const age = facts.digestAgeMs === null ? "not yet observed" : `${Math.round(facts.digestAgeMs / 3_600_000)}h`;
    return { state: "delayed_by_age", reasons: [`digest age ${age} — minimum ${context.config.minUpdateAgeHours}h`] };
  }

  return { state: "eligible", reasons: [`digest age ${Math.round(facts.digestAgeMs / 3_600_000)}h, inside window, all gates passed`] };
}

/** Validates and normalizes an automation config patch (route boundary). */
export function normalizeConfigPatch(patch: {
  enabled?: unknown;
  paused?: unknown;
  maintenance?: {
    enabled?: unknown;
    days?: unknown;
    startHour?: unknown;
    endHour?: unknown;
    timezone?: unknown;
  };
  minUpdateAgeHours?: unknown;
  maxPerWindow?: unknown;
  cooldownHours?: unknown;
}, base: AutomationConfig): { ok: true; config: AutomationConfig } | { ok: false; error: string } {
  const next: AutomationConfig = {
    ...base,
    maintenance: { ...base.maintenance },
  };
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") return { ok: false, error: "enabled must be a boolean" };
    next.enabled = patch.enabled;
  }
  if (patch.paused !== undefined) {
    if (typeof patch.paused !== "boolean") return { ok: false, error: "paused must be a boolean" };
    next.paused = patch.paused;
  }
  if (patch.minUpdateAgeHours !== undefined) {
    const value = Number(patch.minUpdateAgeHours);
    if (!Number.isFinite(value) || value < 0 || value > 336) return { ok: false, error: "minUpdateAgeHours must be 0-336" };
    next.minUpdateAgeHours = value;
  }
  if (patch.maxPerWindow !== undefined) {
    const value = Number(patch.maxPerWindow);
    if (!Number.isInteger(value) || value < 1 || value > 10) return { ok: false, error: "maxPerWindow must be 1-10" };
    next.maxPerWindow = value;
  }
  if (patch.cooldownHours !== undefined) {
    const value = Number(patch.cooldownHours);
    if (!Number.isFinite(value) || value < 1 || value > 720) return { ok: false, error: "cooldownHours must be 1-720" };
    next.cooldownHours = value;
  }
  if (patch.maintenance !== undefined && typeof patch.maintenance === "object" && patch.maintenance !== null) {
    const patchWindow = patch.maintenance;
    if (patchWindow.enabled !== undefined) {
      if (typeof patchWindow.enabled !== "boolean") return { ok: false, error: "maintenance.enabled must be a boolean" };
      next.maintenance.enabled = patchWindow.enabled;
    }
    if (patchWindow.days !== undefined) {
      if (!Array.isArray(patchWindow.days) || patchWindow.days.length === 0 || !patchWindow.days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
        return { ok: false, error: "maintenance.days must be non-empty integers 0-6 (0=Sunday)" };
      }
      next.maintenance.days = [...new Set(patchWindow.days as number[])].sort();
    }
    if (patchWindow.startHour !== undefined) {
      const value = Number(patchWindow.startHour);
      if (!Number.isInteger(value) || value < 0 || value > 23) return { ok: false, error: "startHour must be 0-23" };
      next.maintenance.startHour = value;
    }
    if (patchWindow.endHour !== undefined) {
      const value = Number(patchWindow.endHour);
      if (!Number.isInteger(value) || value < 0 || value > 23) return { ok: false, error: "endHour must be 0-23" };
      next.maintenance.endHour = value;
    }
    if (patchWindow.timezone !== undefined) {
      if (typeof patchWindow.timezone !== "string" || patchWindow.timezone.length === 0 || patchWindow.timezone.length > 64) {
        return { ok: false, error: "timezone must be a non-empty string" };
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: patchWindow.timezone });
      } catch {
        return { ok: false, error: `unknown timezone: ${patchWindow.timezone}` };
      }
      next.maintenance.timezone = patchWindow.timezone;
    }
  }
  if (next.maintenance.startHour === next.maintenance.endHour) {
    return { ok: false, error: "startHour must differ from endHour" };
  }
  return { ok: true, config: next };
}
