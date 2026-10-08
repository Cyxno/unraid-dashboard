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

/* ===========================================================================
 * v1.5.0: incident intelligence thresholds
 *
 * All incident/freshness judgment lives here. freshness.ts is the only
 * place allowed to compare ages against these — no scattered
 * `Date.now() - ts > …` checks anywhere else.
 * =========================================================================== */

/* Canonical freshness (Fase 3) ---------------------------------------------- */

/**
 * Freshness bands relative to a source's own expected interval, with
 * absolute floors so very fast sources don't flap freshness on scheduler
 * jitter: fresh ≤ max(2×interval, FRESH_FLOOR), aging ≤ max(6×interval,
 * AGING_FLOOR), stale beyond. A 5s poll source goes stale after 60s; a
 * 15m SMART/temperature source only after 90m.
 */
export const FRESHNESS_FRESH_FLOOR_MS = 10_000;
export const FRESHNESS_AGING_FLOOR_MS = 60_000;

/* Source expected intervals (Fase 1 matrix — canonical, ms) ----------------- */

export const SOURCE_EXPECTED_INTERVAL_MS: Record<string, number> = {
  "unraid-api": 10_000, // busiest section TTL (metrics 5s, docker 10s)
  prometheus: 5_000, // sampler/instant queries 3-5s caches
  cadvisor: 15_000, // container metric scrape via Prometheus
  "node-exporter": 15_000,
  helper: 60_000, // inventory is demand-driven with a 15m LKG ceiling
  "docker-inventory": 60_000,
  "web-push": 3_600_000, // delivery is event-driven; 1h = "recently proven"
  persistence: 300_000, // debounced saves on state changes; 5m proof window
  "beacon-update": 21_600_000, // registry digest cadence (6h bound)
};

/* Incident lifecycle (Fase 5/12/13) ----------------------------------------- */

/** Recovered incidents kept in history (bounded state-file growth). */
export const INCIDENT_RECOVERED_HISTORY_MAX = 50;
/** Recovered incidents older than this are pruned even below the cap. */
export const INCIDENT_RECOVERY_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Timeline events kept per incident (bounded). */
export const INCIDENT_TIMELINE_MAX = 50;
/** Evidence entries kept per incident (bounded). */
export const INCIDENT_EVIDENCE_MAX = 8;
/** Impact lines kept per source incident (bounded). */
export const INCIDENT_IMPACT_MAX = 12;

/* Debounce / persistence duration (Fase 14) --------------------------------- */

/**
 * Derived signals must persist before they become incidents (one spike is
 * not an incident). Direct signals (Docker health, array state, disk
 * state, source outage) carry NO debounce: their sources already apply
 * their own semantics (Docker healthcheck interval+retries, Unraid
 * notification policy) and double-debouncing would hide real failures.
 */
export const INCIDENT_DEBOUNCE_MS = {
  "memory-pressure": 5 * 60_000,
  "cpu-sustained": 0, // upstream metric is already a 5-minute average
  thermal: 0, // upstream metric is already a 5-minute average (hysteresis v0.6)
  "disk-thermal": 0, // Unraid reports sustained sensor readings
} as const;

/* Docker health explainability / escalation (Fase 9/17) --------------------- */

/**
 * An unhealthy container escalates warning → critical only after it has
 * been unhealthy this long ("belangrijke service LANGDURIG unhealthy").
 * A fresh unhealthy verdict stays a warning: many healthchecks flap once
 * during a slow start, and a critical push per blip is alarm fatigue.
 */
export const CONTAINER_UNHEALTHY_CRITICAL_AFTER_MS = 15 * 60_000;

/* Crash loop (Fase 10) ------------------------------------------------------ */

/**
 * Crash-loop is only claimed on PROVEN patterns:
 * - Docker's own status reports "Restarting" for at least this long, OR
 * - ≥2 restart transitions within the window (restart-count delta).
 * A single manual restart (one EXITED→RUNNING transition) never matches.
 */
export const CRASH_LOOP_RESTARTING_SUSTAINED_MS = 2 * 60_000;
export const CRASH_LOOP_WINDOW_MS = 10 * 60_000;
export const CRASH_LOOP_MIN_RESTARTS = 2;

/* Flapping (Fase 11) -------------------------------------------------------- */

/**
 * A healthy↔unhealthy toggle pattern within the window marks the incident
 * flapping: ONE incident, timeline keeps the toggles, no notification
 * storm (fingerprint never changes, so dedupe holds). Two clears inside
 * the window (healthy→unhealthy→healthy→unhealthy) are a proven flap.
 */
export const FLAP_WINDOW_MS = 15 * 60_000;
export const FLAP_MIN_TRANSITIONS = 2;
/** Healthy-streak required before a flapping incident may recover. */
export const FLAP_RECOVERY_STABLE_MS = 10 * 60_000;

/* Notification backlog (Fase 17 severity audit) ----------------------------- */

/**
 * Unread Unraid notification backlog is INFO, not critical: it is
 * historical signal (often stale repeats), never proof of a CURRENT
 * condition. Active conditions get their own incidents from live state;
 * the backlog only asks for a review.
 */
export const NOTIFICATION_BACKLOG_ALERT_COUNT = 1;
