import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { z } from "zod";
import { getEnv } from "@/server/env";
import type { AuthIdentity } from "@/lib/api-types";

/**
 * Server-side shared dashboard persistence.
 *
 * Storage model (documented in README):
 * - One JSON file per dashboard under DASHBOARDS_DIR (default
 *   /app/data/dashboards), the same narrow app-data volume the audit
 *   log uses. No database.
 * - Filenames are `<id>.json` where id is GENERATED here and validated
 *   against ^[a-z0-9]{12}$ before it ever touches the filesystem — a
 *   request id that fails the regex is rejected before path composition,
 *   so no traversal or unsafe-name vector exists.
 * - Strict zod schema with unknown-field stripping; bounded count and
 *   payload size; no secrets are ever accepted or stored.
 *
 * Ownership model (documented in README §security):
 * - AUTH_MODE=proxy: the authenticated proxy identity owns dashboards it
 *   creates; only the owner may update/delete.
 * - AUTH_MODE=disabled (trusted LAN): every visitor acts as "lan"; all
 *   shared dashboards are trusted-LAN shared resources and editable by
 *   anyone on the trusted network. No accounts are invented.
 */

export const DASHBOARD_SCHEMA_VERSION = 1;

/** Bounded resource limits — reject oversized or sprawling payloads. */
export const DASHBOARD_LIMITS = {
  maxDashboards: 50,
  maxNameLength: 64,
  maxPayloadBytes: 64 * 1024,
  maxDockerFilterLength: 120,
  maxOrderLength: 12,
  maxImportDashboards: 50,
} as const;

/** Overview widget identifiers (subset enforced; unknown ids rejected). */
export const OVERVIEW_WIDGET_IDS = [
  "cpu",
  "memory",
  "uptime",
  "array",
  "network",
  "docker",
] as const;

const widgetIdSchema = z.enum(OVERVIEW_WIDGET_IDS);

/* Field bases (shared between strict storage and stripping input schemas). */

const dashboardLayoutBase = z
  .object({
    /** Widget order; every entry must be a known widget id, no duplicates. */
    order: z.array(widgetIdSchema).max(DASHBOARD_LIMITS.maxOrderLength).default([
      "cpu",
      "memory",
      "uptime",
      "array",
      "network",
      "docker",
    ]),
    /** Widget ids hidden from the overview grid. */
    hidden: z.array(widgetIdSchema).max(DASHBOARD_LIMITS.maxOrderLength).default([]),
  });

const dashboardPreferencesBase = z.object({
  historyWindow: z.enum(["5m", "15m", "1h", "6h", "24h", "7d"]).default("15m"),
  density: z.enum(["compact", "comfortable"]).default("comfortable"),
  tempUnit: z.enum(["C", "F"]).default("C"),
  refresh: z.enum(["fast", "normal", "relaxed"]).default("normal"),
  dockerMetrics: z.boolean().default(true),
  showPerCore: z.boolean().default(true),
  /** Free-text substring filter for the Docker list on the shared page. */
  dockerFilter: z.string().max(DASHBOARD_LIMITS.maxDockerFilterLength).default(""),
});

function layoutRefinements<T extends { order: string[]; hidden: string[] }>(schema: z.ZodType<T>) {
  return schema
    .refine(
      (layout) => layout.order.length === new Set(layout.order).size,
      { message: "order contains duplicate widget ids" },
    )
    .refine(
      (layout) => layout.order.some((id) => !layout.hidden.includes(id)),
      { message: "all widgets are hidden — at least one must remain visible" },
    );
}

/** Strict layout schema for stored documents. */
export const dashboardLayoutSchema = layoutRefinements(dashboardLayoutBase.strict());

/** Input variant: unknown fields stripped, same value rules. */
const dashboardLayoutInputSchema = layoutRefinements(dashboardLayoutBase.strip());

/** Strict preferences schema for stored documents. */
export const dashboardPreferencesSchema = dashboardPreferencesBase.strict();

/** Input variant: unknown fields stripped. */
const dashboardPreferencesInputSchema = dashboardPreferencesBase.strip();

export const dashboardSchema = z
  .object({
    schemaVersion: z.literal(DASHBOARD_SCHEMA_VERSION).default(DASHBOARD_SCHEMA_VERSION),
    id: z.string().regex(/^[a-z0-9]{12}$/),
    name: z.string().trim().min(1).max(DASHBOARD_LIMITS.maxNameLength),
    /** Owner identity (proxy mode) or "lan" (trusted-LAN mode). */
    owner: z.string().trim().min(1).max(64),
    layout: dashboardLayoutSchema,
    preferences: dashboardPreferencesSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type DashboardPreferences = z.infer<typeof dashboardPreferencesSchema>;
export type DashboardLayout = z.infer<typeof dashboardLayoutSchema>;
export type SharedDashboard = z.infer<typeof dashboardSchema>;

/** Public shape (identical — no secrets exist in the schema). */
export type DashboardDto = SharedDashboard;

const importEntrySchema = z
  .object({
    name: z.string().trim().min(1).max(DASHBOARD_LIMITS.maxNameLength),
    layout: dashboardLayoutInputSchema.optional(),
    preferences: dashboardPreferencesInputSchema.optional(),
  })
  .strict();

export type DashboardImportPayload = z.infer<typeof importEntrySchema>;

/* ---- errors ---- */

export class DashboardError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/* ---- id + path safety ---- */

/** Opaque, filesystem-safe, URL-safe id. */
export function newDashboardId(): string {
  return randomBytes(9).toString("base64url").replace(/[^a-z0-9]/gi, "").toLowerCase().padEnd(12, "0").slice(0, 12);
}

function assertValidId(id: string): string {
  if (!/^[a-z0-9]{12}$/.test(id)) {
    // Never build a path from an unvalidated id.
    throw new DashboardError("Invalid dashboard id.", 400);
  }
  return id;
}

function filePath(id: string): string {
  assertValidId(id);
  const env = getEnv();
  const dir = env.DASHBOARDS_DIR;
  // Defense in depth: even with a validated id, resolve and verify.
  const resolved = `${dir}/${id}.json`;
  if (!resolved.startsWith(`${dir}/`) || resolved.includes("..")) {
    throw new DashboardError("Invalid dashboard path.", 400);
  }
  return resolved;
}

function dirPath(): string {
  return getEnv().DASHBOARDS_DIR;
}

/* ---- owner resolution ---- */

/**
 * Effective owner for new dashboards: proxy identity when auth is on,
 * "lan" for trusted-LAN mode. Shared dashboards created while auth is
 * disabled are editable by everyone on the trusted network (documented).
 */
export function ownerFor(identity: AuthIdentity): string {
  if (identity.mode === "proxy" && identity.user) return identity.user;
  return "lan";
}

/** True when the requester may mutate the dashboard. */
export function canMutate(dashboard: SharedDashboard, identity: AuthIdentity): boolean {
  if (identity.mode === "proxy") {
    return Boolean(identity.user) && dashboard.owner === identity.user;
  }
  // Trusted-LAN mode: shared resources of the trusted network.
  return true;
}

/* ---- persistence ---- */

async function ensureDir(): Promise<string> {
  const dir = dirPath();
  await mkdir(dir, { recursive: true });
  return dir;
}

async function readOne(id: string): Promise<SharedDashboard | null> {
  // Validate BEFORE any filesystem work so bad ids reject loudly instead
  // of being swallowed by the not-found path below.
  const target = filePath(id);
  let raw: string;
  try {
    raw = await readFile(target, "utf8");
  } catch {
    return null;
  }
  const parsed = parseDashboardJson(raw);
  if (parsed) return parsed;
  // Older schema version (or legacy doc): migrate with a backup.
  return migrateStoredDashboard(id);
}

/** Parse + validate; malformed files are surfaced, not silently skipped. */
function parseDashboardJson(raw: string): SharedDashboard | null {
  try {
    const parsed = dashboardSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Load all dashboards. Files failing validation are reported in
 * `invalid` (names only) so Diagnostics can flag them without exposing
 * content.
 */
export async function listDashboards(): Promise<{
  dashboards: SharedDashboard[];
  invalid: string[];
}> {
  const dir = dirPath();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { dashboards: [], invalid: [] };
  }
  const dashboards: SharedDashboard[] = [];
  const invalid: string[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    const dashboard = await readOne(id).catch(() => null);
    if (dashboard) dashboards.push(dashboard);
    else invalid.push(name);
  }
  dashboards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { dashboards, invalid };
}

export async function getDashboard(id: string): Promise<SharedDashboard | null> {
  return readOne(id);
}

interface DashboardWriteInput {
  name: string;
  layout?: unknown;
  preferences?: unknown;
}

/** Validates user input strictly, stripping unknown fields. */
function validateInput(input: DashboardWriteInput) {
  const name = typeof input.name === "string" ? input.name.trim().slice(0, DASHBOARD_LIMITS.maxNameLength) : "";
  if (!name) throw new DashboardError("Dashboard name is required.", 400);

  // Input schemas STRIP unknown fields; only value-level violations reject.
  const layout = dashboardLayoutInputSchema.safeParse(input.layout ?? {});
  if (!layout.success) {
    throw new DashboardError(`Invalid layout: ${layout.error.issues.map((i) => i.message).join("; ")}`, 400);
  }
  const preferences = dashboardPreferencesInputSchema.safeParse(input.preferences ?? {});
  if (!preferences.success) {
    throw new DashboardError(
      `Invalid preferences: ${preferences.error.issues.map((i) => i.message).join("; ")}`,
      400,
    );
  }
  return { name, layout: layout.data, preferences: preferences.data };
}

async function writeAtomic(dashboard: SharedDashboard): Promise<void> {
  await ensureDir();
  const target = filePath(dashboard.id);
  const tmp = `${target}.tmp-${randomBytes(4).toString("hex")}`;
  const payload = JSON.stringify(dashboard, null, 2);
  if (Buffer.byteLength(payload, "utf8") > DASHBOARD_LIMITS.maxPayloadBytes) {
    throw new DashboardError("Dashboard payload exceeds the size limit.", 413);
  }
  await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, target);
}

/** Creates a dashboard. Enforces the global count limit. */
export async function createDashboard(
  input: DashboardWriteInput,
  identity: AuthIdentity,
): Promise<SharedDashboard> {
  const { name, layout, preferences } = validateInput(input);

  const { dashboards } = await listDashboards();
  if (dashboards.length >= DASHBOARD_LIMITS.maxDashboards) {
    throw new DashboardError(
      `Dashboard limit reached (${DASHBOARD_LIMITS.maxDashboards}). Delete one before creating another.`,
      409,
    );
  }

  const now = new Date().toISOString();
  const dashboard: SharedDashboard = {
    schemaVersion: DASHBOARD_SCHEMA_VERSION,
    id: newDashboardId(),
    name,
    owner: ownerFor(identity),
    layout,
    preferences,
    createdAt: now,
    updatedAt: now,
  };
  await writeAtomic(dashboard);
  return dashboard;
}

/** Updates an existing dashboard (name/layout/preferences only). */
export async function updateDashboard(
  id: string,
  input: DashboardWriteInput,
  identity: AuthIdentity,
): Promise<SharedDashboard> {
  const existing = await getDashboard(id);
  if (!existing) throw new DashboardError("Dashboard not found.", 404);
  if (!canMutate(existing, identity)) {
    throw new DashboardError("Only the owner may modify this dashboard.", 403);
  }
  const { name, layout, preferences } = validateInput(input);
  const updated: SharedDashboard = {
    ...existing,
    name,
    layout,
    preferences,
    updatedAt: new Date().toISOString(),
  };
  await writeAtomic(updated);
  return updated;
}

export async function deleteDashboard(id: string, identity: AuthIdentity): Promise<void> {
  const existing = await getDashboard(id);
  if (!existing) throw new DashboardError("Dashboard not found.", 404);
  if (!canMutate(existing, identity)) {
    throw new DashboardError("Only the owner may delete this dashboard.", 403);
  }
  await rm(filePath(id), { force: true });
}

/**
 * Imports validated dashboard payloads (from the export format). New ids
 * are always generated; ownership follows the requesting identity; the
 * count limit applies. Unknown fields are stripped by the schema.
 */
export async function importDashboards(
  raw: unknown,
  identity: AuthIdentity,
): Promise<{ imported: SharedDashboard[]; rejected: Array<{ index: number; reason: string }> }> {
  const payloadBytes = typeof raw === "string" ? Buffer.byteLength(raw, "utf8") : null;
  if (payloadBytes !== null && payloadBytes > DASHBOARD_LIMITS.maxPayloadBytes * DASHBOARD_LIMITS.maxImportDashboards) {
    throw new DashboardError("Import payload too large.", 413);
  }

  let parsed: unknown;
  try {
    parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new DashboardError("Import payload is not valid JSON.", 400);
  }

  // Envelope-level validation only; entries are validated one by one so a
  // single bad dashboard is rejected without sinking the whole batch.
  const envelope = z
    .object({
      dashboards: z.array(z.unknown()).min(1).max(DASHBOARD_LIMITS.maxImportDashboards),
    })
    .safeParse(parsed);
  if (!envelope.success) {
    throw new DashboardError(
      `Import rejected: ${envelope.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ")}`,
      400,
    );
  }

  const { dashboards } = await listDashboards();
  const imported: SharedDashboard[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];

  for (const [index, entry] of envelope.data.dashboards.entries()) {
    if (dashboards.length + imported.length >= DASHBOARD_LIMITS.maxDashboards) {
      rejected.push({ index, reason: `Dashboard limit reached (${DASHBOARD_LIMITS.maxDashboards}).` });
      continue;
    }
    try {
      const entryParsed = importEntrySchema.safeParse(entry);
      if (!entryParsed.success) {
        rejected.push({
          index,
          reason: entryParsed.error.issues.map((issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`).join("; "),
        });
        continue;
      }
      const now = new Date().toISOString();
      const dashboard: SharedDashboard = {
        schemaVersion: DASHBOARD_SCHEMA_VERSION,
        id: newDashboardId(),
        name: entryParsed.data.name,
        owner: ownerFor(identity),
        layout: entryParsed.data.layout ?? dashboardLayoutInputSchema.parse({}),
        preferences: entryParsed.data.preferences ?? dashboardPreferencesInputSchema.parse({}),
        createdAt: now,
        updatedAt: now,
      };
      await writeAtomic(dashboard);
      imported.push(dashboard);
    } catch (error) {
      rejected.push({
        index,
        reason: error instanceof DashboardError ? error.message : "Validation failed.",
      });
    }
  }
  return { imported, rejected };
}

/* ---- migration ---- */

/**
 * Migrates a stored dashboard document to the current schema version.
 * v1 is the initial version; future versions extend this function.
 * Returns null when the document cannot be migrated.
 * A `.bak-<ts>` copy of the original file is kept before any rewrite
 * (no silent data loss).
 */
export async function migrateStoredDashboard(id: string): Promise<SharedDashboard | null> {
  const raw = await readFile(filePath(id), "utf8").catch(() => null);
  if (raw === null) return null;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  const version = typeof doc.schemaVersion === "number" ? doc.schemaVersion : 0;
  if (version === DASHBOARD_SCHEMA_VERSION) return parseDashboardJson(raw);

  // v0 (pre-versioning) → v1: fill defaults, stamp version.
  if (version < DASHBOARD_SCHEMA_VERSION) {
    const migrated = dashboardSchema.safeParse({
      // Prefill sections the legacy document may lack so the strict
      // storage schema accepts it; zod fills field defaults.
      ...doc,
      schemaVersion: DASHBOARD_SCHEMA_VERSION,
      id: assertValidId(id),
      owner: typeof doc.owner === "string" && doc.owner.trim() ? doc.owner : "lan",
      layout: doc.layout ?? {},
      preferences: doc.preferences ?? {},
    });
    if (!migrated.success) return null;
    const stamp = new Date().toISOString();
    await writeFile(`${filePath(id)}.bak-${stamp.replace(/[:.]/g, "-")}`, raw, { mode: 0o600 }).catch(() => {});
    await writeAtomic(migrated.data);
    return migrated.data;
  }
  // Future version written by a newer app: refuse to touch it.
  return null;
}

/* ---- health ---- */

export interface DashboardsStorageHealth {
  configured: boolean;
  writable: boolean;
  dashboardCount: number;
  invalidFiles: string[];
  error: string | null;
}

/** Cheap storage probe used by Diagnostics. */
export async function dashboardsStorageHealth(): Promise<DashboardsStorageHealth> {
  try {
    const dir = await ensureDir();
    const probe = `${dir}/.write-probe-${Date.now()}`;
    const handle = await open(probe, "w").catch((error: NodeJS.ErrnoException) => {
      throw error;
    });
    await handle.close();
    await rm(probe, { force: true });
    const { dashboards, invalid } = await listDashboards();
    return {
      configured: true,
      writable: true,
      dashboardCount: dashboards.length,
      invalidFiles: invalid,
      error: null,
    };
  } catch (error) {
    return {
      configured: true,
      writable: false,
      dashboardCount: 0,
      invalidFiles: [],
      error: error instanceof Error ? error.message : "storage probe failed",
    };
  }
}

/** Test hook. */
export function resetDashboardCaches(): void {
  // Reserved for future in-memory caches.
}
