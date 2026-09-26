/**
 * Centralized, documented thresholds for alert-like observations and
 * UI filter presets. Every dashboard judgment ("high", "elevated",
 * "pressure") comes from a constant in this file — there are no hidden
 * magic numbers in components or services.
 *
 * These are heuristics for a homelab dashboard, not alerting rules.
 * They intentionally err toward "attention" (not critical) so the
 * dashboard never cries wolf on things that are plainly normal.
 */

/* Thermal ------------------------------------------------------------------ */

/** CPU package temperature considered elevated (°C). */
export const CPU_TEMP_WARNING_C = 80;
/** CPU package temperature considered critical (°C). */
export const CPU_TEMP_CRITICAL_C = 90;
/** Motherboard / ACPI temperature considered elevated (°C). */
export const BOARD_TEMP_WARNING_C = 70;
/** Motherboard / ACPI temperature considered critical (°C). */
export const BOARD_TEMP_CRITICAL_C = 85;

/**
 * Thermal-episode definition (v0.6 diagnostics). An episode is a
 * *sustained* excursion, never a one-sample spike:
 * - starts when the package temp stays at/above START for MIN_DURATION
 * - ends only after the temp has stayed below END for END_HOLD
 *   (hysteresis: re-crossing START within the hold continues the episode)
 */
export const THERMAL_EPISODE_START_C = CPU_TEMP_WARNING_C; // 80
export const THERMAL_EPISODE_MIN_DURATION_S = 300; // 5 minutes
export const THERMAL_EPISODE_END_C = CPU_TEMP_WARNING_C - 5; // 75
export const THERMAL_EPISODE_END_HOLD_S = 600; // 10 minutes

/**
 * Duration buckets for 24h package-temperature distribution (°C bounds,
 * lower-inclusive): "<70", "70–79", "80–89", "90–94", "≥95".
 */
export const TEMP_BUCKET_BOUNDS = [70, 80, 90, 95] as const;

/** Tolerance (seconds) when aligning two Prometheus series by timestamp. */
export const SERIES_ALIGN_TOLERANCE_S = 90;

/* CPU / load ---------------------------------------------------------------- */

/** Instant or 5m-average host CPU% at which a "high CPU" note appears. */
export const HOST_CPU_HIGH_PERCENT = 90;
/** Sustained (5m average) CPU% considered worth an observation. */
export const HOST_CPU_SUSTAINED_HIGH_PERCENT = 85;

/**
 * Load is judged relative to CPU thread count, never against an
 * arbitrary absolute number:
 * - load5 >  threads          → "high"
 * - load5 >  threads / 2      → "elevated"
 * - otherwise                 → "normal"
 */
export const LOAD_HIGH_PER_THREAD = 1.0;
export const LOAD_ELEVATED_PER_THREAD = 0.5;

/* Memory -------------------------------------------------------------------- */

/** Host RAM% at which a memory-pressure observation appears. */
export const HOST_MEM_WARNING_PERCENT = 90;
export const HOST_MEM_CRITICAL_PERCENT = 95;

/**
 * A container counts as "high memory" when it exceeds either
 * threshold (absolute bytes OR % of its own limit when a real limit
 * exists). Matches the Docker-page filter and Overview counters.
 */
export const CONTAINER_HIGH_MEMORY_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
export const CONTAINER_HIGH_MEMORY_PERCENT_OF_LIMIT = 80;
/** Container CPU% ("high CPU" filter / observation). */
export const CONTAINER_HIGH_CPU_PERCENT = 80;

/**
 * Docker reports the host's *physical* RAM as the memory limit of
 * unlimited containers, while node-exporter's MemTotal is the *usable*
 * RAM — they differ by a few MB of firmware/kernel reservations
 * (measured ~1.4 MB on this host). A limit within this tolerance of the
 * host total is treated as "no limit" so we never fake a % of limit.
 */
export const MEMORY_LIMIT_HOST_TOLERANCE_BYTES = 32 * 1024 * 1024; // 32 MiB

/* History observations ------------------------------------------------------- */

/** Prometheus response windows considered too old to serve as "live". */
export const PROMETHEUS_STALE_MS = 90_000;
