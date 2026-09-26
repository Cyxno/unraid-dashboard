import { getPromClient, isPrometheusConfigured } from "@/server/prometheus/client";
import { getUnraidClient } from "@/server/unraid/client";
import { deriveHealth } from "@/server/health";

/**
 * Shared server-side sampler for SSE. ONE loop per process (never per
 * browser tab): samples lightweight instant state from the existing
 * service layer, derives normalized events, and fans them out to
 * subscribers. Stops itself when the last subscriber disconnects.
 *
 * Events (small, no history bulk, no secrets):
 * - snapshot: cpu %, ram %, package temp, load5 — every 5s
 * - docker: running/total counts — every 10s or on change
 * - health: level + reasons — on change only
 * - docker-events: observed container state transitions — on change
 * - notifications: unread alert/warning counts — every 30s
 */

export interface SampledEvent {
  event: string;
  data: unknown;
}

type Subscriber = (event: SampledEvent) => void;

const globalStore = globalThis as unknown as {
  __dashboardSse?: {
    subscribers: Set<Subscriber>;
    timer: ReturnType<typeof setInterval> | null;
    tick: number;
    lastHealth: string | null;
    lastDockerCounts: string | null;
    lastNotifications: string | null;
    /** Bounded observed state transitions: newest first. */
    transitions: Array<{
      name: string;
      from: string;
      to: string;
      at: string;
    }>;
    lastStates: Map<string, { name: string; state: string }>;
  };
};

function store() {
  if (!globalStore.__dashboardSse) {
    globalStore.__dashboardSse = {
      subscribers: new Set(),
      timer: null,
      tick: 0,
      lastHealth: null,
      lastDockerCounts: null,
      lastNotifications: null,
      transitions: [],
      lastStates: new Map(),
    };
  }
  return globalStore.__dashboardSse;
}

const MAX_TRANSITIONS = 100;

async function sampleOnce(): Promise<SampledEvent[]> {
  const s = store();
  const events: SampledEvent[] = [];
  s.tick += 1;

  /* System snapshot — cheap instant metrics (Prometheus cached 2–3s). */
  try {
    if (isPrometheusConfigured()) {
      const { getSystemSnapshot } = await import("@/server/prometheus/system");
      const { getThermalSnapshot } = await import("@/server/prometheus/thermal");
      const client = getPromClient();
      const [snap, thermal] = await Promise.all([
        getSystemSnapshot(client),
        getThermalSnapshot(client),
      ]);
      events.push({
        event: "snapshot",
        data: {
          cpuPercent: snap.cpuPercent,
          memoryPercent:
            snap.memory.totalBytes && snap.memory.usedBytes !== null
              ? (snap.memory.usedBytes / snap.memory.totalBytes) * 100
              : null,
          load5: snap.load.five,
          packageC: thermal.packageC,
          hottest: thermal.hottestName,
        },
      });
    }
  } catch {
    // Prometheus unavailable — snapshot events pause, dashboard polls still work.
  }

  /* Docker counts + observed state transitions (read key, 10s cadence). */
  if (s.tick % 2 === 0) {
    try {
      const payload = await getUnraidClient().request(
        // Lightweight dedicated query: id/names/state only.
        (await import("@/server/unraid/queries")).DOCKER_STATE_QUERY,
      );
      const containers: Array<{ id: string; names: string[]; state: string }> =
        (payload as { docker?: { containers?: Array<{ id: string; names: string[]; state: string }> } })
          ?.docker?.containers ?? [];
      const running = containers.filter((c) => c.state === "RUNNING").length;
      const counts = `${running}/${containers.length}`;
      if (counts !== s.lastDockerCounts) {
        s.lastDockerCounts = counts;
        events.push({ event: "docker", data: { running, total: containers.length } });
      }

      // Observe per-container state transitions (bounded, factual only).
      const seen = new Set<string>();
      for (const container of containers) {
        const name = String(container.names?.[0] ?? "").replace(/^\//, "");
        seen.add(container.id);
        const previous = s.lastStates.get(container.id);
        if (previous && previous.state !== container.state) {
          s.transitions.unshift({
            name,
            from: previous.state,
            to: container.state,
            at: new Date().toISOString(),
          });
          if (s.transitions.length > MAX_TRANSITIONS) s.transitions.length = MAX_TRANSITIONS;
          events.push({
            event: "state-transition",
            data: { name, from: previous.state, to: container.state, at: s.transitions[0]!.at },
          });
        }
        s.lastStates.set(container.id, { name, state: container.state });
      }
      for (const id of [...s.lastStates.keys()]) {
        if (!seen.has(id)) s.lastStates.delete(id); // container removed
      }
    } catch {
      // Unraid unavailable — skip this cycle.
    }
  }

  /* Health + notifications — on change only, 10s cadence. */
  if (s.tick % 2 === 1) {
  try {
    const [{ getOverview }, { getMetricsHistory }] = await Promise.all([
      import("@/server/unraid/service"),
      import("@/server/history"),
    ]);
    void getMetricsHistory;
    const overview = await getOverview("5m");
    const healthKey = JSON.stringify([overview.health.level, overview.health.reasons]);
    if (healthKey !== s.lastHealth) {
      s.lastHealth = healthKey;
      events.push({
        event: "health",
        data: { level: overview.health.level, reasons: overview.health.reasons },
      });
    }

    /* Notifications — 30s cadence. */
    if (s.tick % 6 === 0) {
      const unread = overview.notifications.data?.unreadCounts;
      const notifKey = unread ? JSON.stringify(unread) : null;
      if (unread && notifKey !== s.lastNotifications) {
        s.lastNotifications = notifKey;
        events.push({ event: "notifications", data: unread });
      }
    }
  } catch {
    // ignore
  }
  }

  return events;
}

/** Sends one event to every subscriber (dead subscribers are isolated). */
function dispatch(event: SampledEvent): void {
  const s = store();
  for (const subscriber of s.subscribers) {
    try {
      subscriber(event);
    } catch {
      // a broken callback must not break other subscribers
    }
  }
}

function ensureSampler(): void {
  const s = store();
  if (s.timer) return;
  s.timer = setInterval(async () => {
    if (s.subscribers.size === 0) return; // nothing to serve
    let events: SampledEvent[] = [];
    try {
      events = await sampleOnce();
    } catch {
      return;
    }
    for (const event of events) {
      dispatch(event);
    }
  }, 5_000);
  // Never keep the process alive just for the sampler.
  (s.timer as unknown as { unref?: () => void }).unref?.();
}

export function subscribe(subscriber: Subscriber): () => void {
  const s = store();
  s.subscribers.add(subscriber);
  ensureSampler();
  return () => {
    s.subscribers.delete(subscriber);
    // Sampler keeps running but idles at zero subscribers (one interval,
    // no work); it self-terminates with the process.
  };
}

/** Recent observed transitions (bounded) for initial SSE catch-up/UI. */
export function recentTransitions(): Array<{ name: string; from: string; to: string; at: string }> {
  return [...store().transitions];
}

/** Test hook: record an observed transition as the sampler would. */
export function recordTransitionForTest(
  name: string,
  from: string,
  to: string,
): void {
  const s = store();
  s.transitions.unshift({ name, from, to, at: new Date().toISOString() });
  if (s.transitions.length > MAX_TRANSITIONS) s.transitions.length = MAX_TRANSITIONS;
}

/** Test hook: dispatch an event to current subscribers. */
export function dispatchForTest(event: SampledEvent): void {
  dispatch(event);
}

/** Test hooks. */
export function resetSseStore(): void {
  const s = store();
  if (s.timer) clearInterval(s.timer);
  globalStore.__dashboardSse = undefined;
}

export function subscriberCount(): number {
  return store().subscribers.size;
}

/** True when the shared sampler loop is currently ticking. */
export function samplerRunning(): boolean {
  return globalStore.__dashboardSse?.timer != null;
}
