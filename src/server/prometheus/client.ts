import { getEnv, isPrometheusConfigured } from "@/server/env";
import { PROMETHEUS_STALE_MS } from "@/server/thresholds";

/**
 * Server-only Prometheus HTTP client.
 *
 * - Query strings are always built from server-defined PromQL constants;
 *   no PromQL is ever accepted from the browser.
 * - Results are typed and defensively parsed: NaN / null / missing values
 *   become `null`, never invented numbers.
 * - Failures normalize to `PrometheusError` with a machine-readable kind
 *   so routes can degrade gracefully.
 * - A small TTL memo keeps repeated browser polls from re-running the
 *   same range query against Prometheus.
 */

export type PromKind =
  | "not-configured"
  | "unavailable"
  | "timeout"
  | "bad-response";

export class PrometheusError extends Error {
  readonly kind: PromKind;
  constructor(kind: PromKind, message: string) {
    super(message);
    this.name = "PrometheusError";
    this.kind = kind;
  }
}

/** A single value in an instant-vector result. */
export interface PromSample {
  metric: Record<string, string>;
  /** Epoch seconds (Prometheus timestamps). */
  t: number;
  /** Parsed number, or null for NaN/±Inf/missing. */
  v: number | null;
}

/** A range-vector series. */
export interface PromSeries {
  metric: Record<string, string>;
  points: Array<{ t: number; v: number | null }>;
}

interface ApiVectorResponse {
  status: string;
  data?: {
    resultType: "vector" | "matrix";
    result?: Array<{
      metric?: Record<string, string>;
      value?: [number, string];
      values?: Array<[number, string]>;
    }>;
  };
  error?: string;
}

export type ValueType = "vector" | "matrix";

function parseValue(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  // Prometheus returns NaN / +Inf / -Inf as strings; they carry no
  // displayable value for this dashboard, so they become null.
  return Number.isFinite(parsed) ? parsed : null;
}

export class PromClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: Partial<{ url: string; timeoutMs: number }> = {}) {
    if (options.url) {
      this.baseUrl = options.url.replace(/\/+$/, "");
      this.timeoutMs = options.timeoutMs ?? 5_000;
    } else {
      const env = getEnv();
      if (!env.PROMETHEUS_URL) {
        throw new PrometheusError(
          "not-configured",
          "PROMETHEUS_URL is not configured",
        );
      }
      this.baseUrl = env.PROMETHEUS_URL;
      this.timeoutMs = options.timeoutMs ?? env.PROMETHEUS_TIMEOUT_MS;
    }
  }

  get targetUrl(): string {
    return this.baseUrl;
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(url.toString(), {
        signal: controller.signal,
        cache: "no-store",
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new PrometheusError(
          "timeout",
          `Prometheus request timed out after ${this.timeoutMs}ms`,
        );
      }
      throw new PrometheusError(
        "unavailable",
        `Cannot reach Prometheus: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new PrometheusError(
        "bad-response",
        `Prometheus responded with HTTP ${response.status}`,
      );
    }

    let body: ApiVectorResponse;
    try {
      body = (await response.json()) as ApiVectorResponse;
    } catch {
      throw new PrometheusError(
        "bad-response",
        "Prometheus returned malformed JSON",
      );
    }
    if (body.status !== "success" || !body.data) {
      throw new PrometheusError(
        "bad-response",
        `Prometheus query failed: ${body.error ?? "unknown error"}`,
      );
    }
    return body.data as unknown as T;
  }

  /** Instant query → one sample per series. */
  async instant(query: string, at?: number): Promise<PromSample[]> {
    const params: Record<string, string> = { query };
    if (at !== undefined) params.time = String(Math.floor(at));
    const data = await this.get<ApiVectorResponse["data"]>(
      "/api/v1/query",
      params,
    
    );
    const result = data?.result ?? [];
    return result.map((entry) => ({
      metric: entry.metric ?? {},
      t: entry.value?.[0] ?? 0,
      v: parseValue(entry.value?.[1]),
    }));
  }

  /** Range query → per-series point lists. */
  async range(
    query: string,
    startSeconds: number,
    endSeconds: number,
    stepSeconds: number,
  ): Promise<PromSeries[]> {
    const data = await this.get<ApiVectorResponse["data"]>(
      "/api/v1/query_range",
      {
        query,
        start: String(Math.floor(startSeconds)),
        end: String(Math.floor(endSeconds)),
        step: String(Math.max(1, Math.floor(stepSeconds))),
      },
    );
    const result = data?.result ?? [];
    return result.map((entry) => ({
      metric: entry.metric ?? {},
      points: (entry.values ?? []).map(([t, raw]) => ({
        t,
        v: parseValue(raw),
      })),
    }));
  }

  /**
   * Liveness + latency probe. Cheap, unauthenticated, no metrics read.
   * Returns null when unreachable (never throws).
   */
  async probe(): Promise<{ reachable: boolean; latencyMs: number | null }> {
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      try {
        const response = await fetch(`${this.baseUrl}/-/healthy`, {
          signal: controller.signal,
          cache: "no-store",
        });
        return { reachable: response.ok, latencyMs: Date.now() - started };
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      return { reachable: false, latencyMs: null };
    }
  }
}

/* Shared singleton + TTL memo ------------------------------------------ */

const globalStore = globalThis as unknown as {
  __dashboardPromClient?: PromClient;
};

export function getPromClient(): PromClient {
  if (!globalStore.__dashboardPromClient) {
    globalStore.__dashboardPromClient = new PromClient();
  }
  return globalStore.__dashboardPromClient;
}

interface CacheEntry {
  at: number;
  value: unknown;
}

const globalCache = globalThis as unknown as {
  __dashboardPromCache?: Map<string, CacheEntry>;
};

function cacheMap(): Map<string, CacheEntry> {
  if (!globalCache.__dashboardPromCache) {
    globalCache.__dashboardPromCache = new Map();
  }
  return globalCache.__dashboardPromCache;
}

/** Runs `fn` and serves the cached result for `ttlMs` afterwards. */
export async function withCache<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const map = cacheMap();
  const cached = map.get(key);
  const now = Date.now();
  if (cached && now - cached.at < ttlMs) {
    return cached.value as T;
  }
  const value = await fn();
  map.set(key, { at: now, value });
  // Keep the map bounded: drop entries older than 15 minutes.
  if (map.size > 128) {
    for (const [entryKey, entry] of map) {
      if (now - entry.at > 15 * 60_000) map.delete(entryKey);
    }
  }
  return value;
}

/**
 * True when the supplied fetch timestamp is fresh enough to be presented
 * as "live" (Prometheus scrapes at 15s; anything much older than that is
 * effectively stale data from an exporter that stopped reporting).
 */
export function isFreshSample(fetchedAtMs: number, now = Date.now()): boolean {
  return now - fetchedAtMs < PROMETHEUS_STALE_MS;
}

export { isPrometheusConfigured };
