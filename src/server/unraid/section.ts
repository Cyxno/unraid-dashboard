import type { SourceStatus, Section } from "@/lib/api-types";

export interface SectionOptions {
  /** Status to assign when data was fetched fresh right now. */
  fresh?: SourceStatus;
}

/**
 * Wraps a domain fetch with the dashboard's data-provenance contract:
 *
 * - success            -> "live"  (or "demo" for the built-in demo data)
 * - failure + lastGood -> "stale" (previous data retained, reason attached)
 * - failure, no prior  -> "unavailable" (data: null)
 * - never configured / never succeeded -> "demo" via explicit demo payload
 *
 * A per-section TTL cache lets several clients and pages poll at their own
 * cadence while the server actually hits Unraid at most once per TTL.
 */
export class SectionProvider<T> {
  private lastGood: { data: T; at: number } | null = null;
  private lastSuccessAt: number | null = null;
  private lastError: { message: string; at: number } | null = null;
  private pending: Promise<T> | null = null;
  private cached: { data: T; at: number } | null = null;
  private everSucceeded = false;
  private lastFailureAt: number | null = null;
  private readonly failureBackoffMs: number;

  constructor(
    private readonly name: string,
    private readonly fetcher: () => Promise<T>,
    private readonly ttlMs: number,
    options: { failureBackoffMs?: number } = {},
  ) {
    // After a failed refresh the cache is gone; without a negative window
    // every poll would fire a live upstream request (no backoff during an
    // outage). 5s keeps recovery fast while bounding the retry storm.
    this.failureBackoffMs = options.failureBackoffMs ?? 5_000;
  }

  /** True if this section has ever fetched successfully this process. */
  get hasLive(): boolean {
    return this.everSucceeded;
  }

  get lastSuccess(): number | null {
    return this.lastSuccessAt;
  }

  async get(): Promise<Section<T>> {
    const now = Date.now();
    if (
      this.cached &&
      now - this.cached.at < this.ttlMs &&
      this.everSucceeded
    ) {
      return this.wrap(this.cached.data, this.cached.at, "live", now - this.cached.at);
    }

    if (!this.pending) {
      // Negative cache: within the failure backoff window the degraded
      // answer is served WITHOUT waking upstream again (polls during an
      // outage must not translate into a request per poll). A successful
      // fetch clears the window, so normal TTL refetches stay immediate.
      const backoffActive =
        this.lastFailureAt !== null &&
        now - this.lastFailureAt < this.failureBackoffMs;
      if (backoffActive) {
        if (this.lastGood) {
          return this.wrap(
            this.lastGood.data,
            this.lastGood.at,
            "stale",
            now - this.lastGood.at,
            this.lastError?.message,
          );
        }
        return {
          status: "unavailable",
          data: null,
          fetchedAt: new Date(this.lastError?.at ?? now).toISOString(),
          ageMs: 0,
          reason: this.lastError?.message ?? "upstream unavailable",
        };
      }
      this.pending = this.fetcher()
        .then((data) => {
          const at = Date.now();
          this.lastGood = { data, at };
          this.cached = { data, at };
          this.lastSuccessAt = at;
          this.lastError = null;
          this.lastFailureAt = null;
          this.everSucceeded = true;
          return data;
        })
        .catch((error: unknown) => {
          this.lastError = {
            message: error instanceof Error ? error.message : String(error),
            at: Date.now(),
          };
          this.lastFailureAt = Date.now();
          // Do not serve an expired cache as fresh after a failed refresh.
          this.cached = null;
          // Re-throw a normalized error to the section wrapper below.
          throw error;
        })
        .finally(() => {
          this.pending = null;
        });
    }

    try {
      const data = await this.pending;
      return this.wrap(data, Date.now(), "live", 0);
    } catch (error) {
      const reason =
        this.lastError?.message ??
        (error instanceof Error ? error.message : "unknown error");
      if (this.lastGood) {
        return this.wrap(
          this.lastGood.data,
          this.lastGood.at,
          "stale",
          Date.now() - this.lastGood.at,
          reason,
        );
      }
      return {
        status: "unavailable",
        data: null,
        fetchedAt: new Date().toISOString(),
        ageMs: 0,
        reason,
      };
    }
  }

  private wrap(
    data: T,
    at: number,
    status: SourceStatus,
    ageMs: number,
    reason?: string,
  ): Section<T> {
    return {
      status,
      data,
      fetchedAt: new Date(at).toISOString(),
      ageMs,
      reason,
    };
  }
}
