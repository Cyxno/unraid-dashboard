import type { HistoryWindow, ResourceSample } from "@/lib/api-types";

/**
 * In-memory rolling metrics history. Since v0.3 this is only the
 * fallback for the Overview chart while Prometheus is unavailable
 * (Prometheus range queries are the source of historical truth);
 * the buffer still resets when the container restarts.
 */

const MIN_SAMPLE_INTERVAL_MS = 5_000;
export const RETENTION_MS = 2 * 60 * 60 * 1000; // 2 hours

const WINDOW_MS: Record<HistoryWindow, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
};

/** Never render more points than this — charts stay cheap. */
const MAX_POINTS = 360;

export class MetricsHistory {
  private samples: ResourceSample[] = [];

  /** Records a sample unless one was recorded very recently. */
  record(sample: Omit<ResourceSample, "time">, now = Date.now()): boolean {
    const last = this.samples.at(-1);
    if (last && now - last.time < MIN_SAMPLE_INTERVAL_MS) return false;
    this.samples.push({ ...sample, time: now });
    this.prune(now);
    return true;
  }

  private prune(now = Date.now()): void {
    const cutoff = now - RETENTION_MS;
    while (this.samples.length > 0 && (this.samples[0]?.time ?? Infinity) < cutoff) {
      this.samples.shift();
    }
  }

  get totalSamples(): number {
    return this.samples.length;
  }

  windowFilled(window: HistoryWindow, now = Date.now()): boolean {
    const first = this.samples[0];
    if (!first) return false;
    return now - first.time >= WINDOW_MS[window];
  }

  /**
   * Returns samples for the requested window, downsampled by stride so
   * charts never receive more than MAX_POINTS points.
   */
  slice(window: HistoryWindow, now = Date.now()): ResourceSample[] {
    const cutoff = now - WINDOW_MS[window];
    const inWindow = this.samples.filter((sample) => sample.time >= cutoff);
    if (inWindow.length <= MAX_POINTS) return inWindow;
    const stride = Math.ceil(inWindow.length / MAX_POINTS);
    return inWindow.filter((_, index) => index % stride === 0 || index === inWindow.length - 1);
  }
}

/* Shared across route invocations and HMR (Next dev). */
const globalStore = globalThis as unknown as { __dashboardHistory?: MetricsHistory };

export function getMetricsHistory(): MetricsHistory {
  if (!globalStore.__dashboardHistory) {
    globalStore.__dashboardHistory = new MetricsHistory();
  }
  return globalStore.__dashboardHistory;
}
