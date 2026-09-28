import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { getEnvSafe } from "@/server/env";
import { DEFAULT_CONFIG, POLICY_VERSION, type AutomationConfig } from "./policy";

/**
 * Persistent automation state (v0.8.0). Three bounded JSON files under
 * /app/data — the same volume as audit/history — written atomically
 * (tmp + rename). Never contains secrets.
 *
 *   automation-state.json   config + per-target opt-ins/cooldowns/interventions
 *   automation-queue.json   queued auto jobs (durable, revalidated on load)
 *   digest-firstseen.json   first/last-seen per image+digest (age delay)
 *   automation-events.jsonl operator-facing event feed (bounded)
 */

export interface TargetAutomationState {
  optIn: boolean;
  cooldownUntil: string | null;
  cooldownReason: string | null;
  interventionRequired: boolean;
  interventionReason: string | null;
}

export interface AutomationState {
  policyVersion: string;
  config: AutomationConfig;
  targets: Record<string, TargetAutomationState>;
  /** Auto mutations executed in the current window (counter). */
  windowOperationsUsed: number;
  windowStartedAt: string;
}

export interface QueuedJob {
  id: string;
  target: string;
  scope: "container" | "compose";
  image: string;
  digest: string | null;
  /** Digest age (ms) at enqueue time — revalidated before execution. */
  digestFirstSeenAt: string | null;
  reasons: string[];
  policyVersion: string;
  createdAt: string;
  state: "queued" | "updating" | "verifying";
}

const STATE_FILE = "automation-state.json";
const QUEUE_FILE = "automation-queue.json";
const DIGEST_FILE = "digest-firstseen.json";
const EVENTS_FILE = "automation-events.jsonl";
const MAX_EVENTS = 100;
const MAX_DIGEST_ENTRIES = 200;

const globalStore = globalThis as unknown as {
  __automationState?: AutomationState | null;
  __automationQueue?: QueuedJob[] | null;
  __automationDigests?: Record<string, { digest: string; firstSeenAt: string; lastSeenAt: string }> | null;
};

function dir(): string {
  return getEnvSafe().AUDIT_DIR;
}

function filePath(name: string): string {
  return `${dir()}/${name}`;
}

async function readJson<T>(name: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath(name), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function writeJsonAtomic(name: string, value: unknown): Promise<void> {
  // Bounded: a pathological filesystem (procfs, dead mount) must never hang
  // the scheduler. Persistence failure = rejection = tick skipped cleanly.
  const bounded = <T>(work: Promise<T>): Promise<T> =>
    Promise.race([
      work,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error("automation state write timed out")), 5_000)),
    ]);
  await bounded(mkdir(dir(), { recursive: true }).catch(() => {}));
  const tmp = `${filePath(name)}.tmp`;
  await bounded(writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }));
  await bounded(
    rename(tmp, filePath(name)).catch(async () => {
      await bounded(writeFile(filePath(name), JSON.stringify(value, null, 2), { mode: 0o600 }));
    }),
  );
}

/* ---- state -------------------------------------------------------------- */

export function emptyState(): AutomationState {
  return {
    policyVersion: POLICY_VERSION,
    config: structuredClone(DEFAULT_CONFIG),
    targets: {},
    windowOperationsUsed: 0,
    windowStartedAt: new Date().toISOString(),
  };
}

export async function loadState(): Promise<AutomationState> {
  if (globalStore.__automationState) return globalStore.__automationState;
  const persisted = await readJson<AutomationState>(STATE_FILE);
  const state = persisted && persisted.config && persisted.targets
    ? {
        ...persisted,
        config: { ...structuredClone(DEFAULT_CONFIG), ...persisted.config, maintenance: { ...DEFAULT_CONFIG.maintenance, ...persisted.config.maintenance } },
        targets: persisted.targets ?? {},
      }
    : emptyState();
  globalStore.__automationState = state;
  return state;
}

export async function saveState(state: AutomationState): Promise<void> {
  globalStore.__automationState = state;
  await writeJsonAtomic(STATE_FILE, state);
}

export function targetState(state: AutomationState, name: string): TargetAutomationState {
  return state.targets[name] ?? { optIn: false, cooldownUntil: null, cooldownReason: null, interventionRequired: false, interventionReason: null };
}

export async function updateTarget(name: string, patch: Partial<TargetAutomationState>): Promise<AutomationState> {
  const state = await loadState();
  const current = targetState(state, name);
  state.targets[name] = { ...current, ...patch };
  await saveState(state);
  return state;
}

/** Resets the window counter when the maintenance window rolls over. */
export async function ensureWindowCounter(now: Date, config: AutomationConfig): Promise<AutomationState> {
  const state = await loadState();
  const windowKey = `${now.toISOString().slice(0, 10)}`;
  const storedKey = state.windowStartedAt.slice(0, 10);
  if (windowKey !== storedKey) {
    state.windowOperationsUsed = 0;
    state.windowStartedAt = now.toISOString();
    await saveState(state);
  }
  void config;
  return state;
}

/* ---- queue -------------------------------------------------------------- */

export async function loadQueue(): Promise<QueuedJob[]> {
  if (globalStore.__automationQueue) return globalStore.__automationQueue;
  const persisted = await readJson<{ jobs?: QueuedJob[] }>(QUEUE_FILE);
  const jobs = Array.isArray(persisted?.jobs) ? persisted.jobs : [];
  globalStore.__automationQueue = jobs;
  return jobs;
}

export async function saveQueue(jobs: QueuedJob[]): Promise<void> {
  globalStore.__automationQueue = jobs;
  await writeJsonAtomic(QUEUE_FILE, { jobs });
}

export async function enqueueJob(job: Omit<QueuedJob, "id" | "createdAt" | "state" | "policyVersion">): Promise<QueuedJob> {
  const jobs = await loadQueue();
  const full: QueuedJob = {
    ...job,
    id: `auto-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    state: "queued",
    policyVersion: POLICY_VERSION,
  };
  const deduped = jobs.filter((entry) => entry.target !== job.target);
  await saveQueue([...deduped, full].slice(-20));
  return full;
}

export async function updateJob(id: string, patch: Partial<QueuedJob>): Promise<QueuedJob | null> {
  const jobs = await loadQueue();
  const index = jobs.findIndex((entry) => entry.id === id);
  if (index === -1) return null;
  jobs[index] = { ...jobs[index]!, ...patch };
  await saveQueue(jobs);
  return jobs[index]!;
}

export async function removeJobs(predicate: (job: QueuedJob) => boolean): Promise<QueuedJob[]> {
  const jobs = await loadQueue();
  const kept = jobs.filter((job) => !predicate(job));
  if (kept.length !== jobs.length) await saveQueue(kept);
  return kept;
}

/* ---- digest first-seen store --------------------------------------------- */

export interface DigestObservation {
  digest: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export async function loadDigests(): Promise<Record<string, DigestObservation>> {
  if (globalStore.__automationDigests) return globalStore.__automationDigests;
  const persisted = await readJson<Record<string, DigestObservation>>(DIGEST_FILE);
  const digests = persisted && typeof persisted === "object" ? persisted : {};
  globalStore.__automationDigests = digests;
  return digests;
}

/**
 * Records one observation of an image's remote digest. A digest change
 * RESETS firstSeenAt (tag mutation handling): age always refers to the
 * digest that would actually be applied.
 */
export async function observeDigest(image: string, digest: string, now: Date): Promise<DigestObservation> {
  const digests = await loadDigests();
  const key = image.slice(0, 200);
  const previous = digests[key];
  const nowIso = now.toISOString();
  let observation: DigestObservation;
  if (previous && previous.digest === digest) {
    observation = { ...previous, lastSeenAt: nowIso };
  } else {
    observation = { digest, firstSeenAt: nowIso, lastSeenAt: nowIso };
  }
  digests[key] = observation;
  // Bounded history: keep the 200 most recently seen entries.
  const keys = Object.keys(digests);
  if (keys.length > MAX_DIGEST_ENTRIES) {
    for (const stale of keys
      .sort((a, b) => Date.parse(digests[a]!.lastSeenAt) - Date.parse(digests[b]!.lastSeenAt))
      .slice(0, keys.length - MAX_DIGEST_ENTRIES)) {
      delete digests[stale];
    }
  }
  globalStore.__automationDigests = digests;
  await writeJsonAtomic(DIGEST_FILE, digests);
  return observation;
}

export async function digestAgeMs(image: string, digest: string | null, now: Date): Promise<number | null> {
  if (!digest) return null;
  const digests = await loadDigests();
  const observation = digests[image.slice(0, 200)];
  if (!observation || observation.digest !== digest) return null;
  return Math.max(0, now.getTime() - Date.parse(observation.firstSeenAt));
}

/* ---- events -------------------------------------------------------------- */

export type AutomationEventKind =
  | "auto_update_completed"
  | "auto_update_rolled_back"
  | "auto_update_blocked"
  | "cooldown_entered"
  | "intervention_required"
  | "queue_cancelled"
  | "config_changed";

export interface AutomationEvent {
  id: string;
  at: string;
  kind: AutomationEventKind;
  target: string | null;
  message: string;
  policyVersion: string;
}

export async function recordEvent(kind: AutomationEventKind, target: string | null, message: string): Promise<AutomationEvent> {
  const event: AutomationEvent = {
    id: `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    kind,
    target,
    message: message.slice(0, 300),
    policyVersion: POLICY_VERSION,
  };
  await mkdir(dir(), { recursive: true }).catch(() => {});
  const previous = await readFile(filePath(EVENTS_FILE), "utf8").catch(() => "");
  const lines = previous.split("\n").filter((line) => line.trim().length > 0);
  lines.push(JSON.stringify(event));
  const bounded = lines.slice(-MAX_EVENTS);
  await writeJsonAtomic(EVENTS_FILE + ".tmp", null).catch(() => {});
  await writeFile(`${filePath(EVENTS_FILE)}.tmp`, bounded.join("\n") + "\n", { mode: 0o600 });
  await rename(`${filePath(EVENTS_FILE)}.tmp`, filePath(EVENTS_FILE)).catch(() => {});
  return event;
}

export async function readEvents(limit = 30): Promise<AutomationEvent[]> {
  const raw = await readFile(filePath(EVENTS_FILE), "utf8").catch(() => "");
  const events = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as AutomationEvent;
      } catch {
        return null;
      }
    })
    .filter((event): event is AutomationEvent => event !== null);
  return events.reverse().slice(0, limit);
}

/** Test hook. */
export function resetAutomationStores(): void {
  globalStore.__automationState = null;
  globalStore.__automationQueue = null;
  globalStore.__automationDigests = null;
}
