/**
 * Notification system types (v1.2.0).
 *
 * One pipeline: sources produce raw events with STABLE fingerprints → the
 * engine dedupes against the persisted active set, applies user
 * preferences, and hands approved notifications to the dispatcher
 * (web push + in-app SSE). Delivery results land in the history ring.
 */

export type EventSeverity = "info" | "warning" | "critical";

export type EventCategory =
  | "system-health"
  | "docker-health"
  | "docker-updates"
  | "storage"
  | "beacon-updates"
  | "services"
  | "resolved"
  | "insights";

export interface RawEvent {
  /** Stable fingerprint, e.g. "docker:container:plex:unhealthy". Same
   *  logical event = same fingerprint across polls and restarts. */
  fingerprint: string;
  category: EventCategory;
  severity: EventSeverity;
  title: string;
  body: string;
  source: string;
  /** Page to open on notification click (must be a real route). */
  url: string;
  occurredAt: number;
}

export interface ActiveEvent {
  fingerprint: string;
  severity: EventSeverity;
  category: EventCategory;
  title: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** When a notification for this fingerprint was last dispatched. */
  notifiedAt: number | null;
}

export type DeliveryStatus =
  | "pushed"
  | "skipped-preference"
  | "skipped-unconfigured"
  | "failed"
  | "in-app";

export interface NotificationRecord {
  /** Monotonic id within the state file. */
  id: number;
  fingerprint: string;
  category: EventCategory;
  severity: EventSeverity;
  title: string;
  body: string;
  source: string;
  url: string;
  occurredAt: string;
  /** "resolved" records reference the fingerprint that cleared. */
  kind: "event" | "resolved" | "test" | "digest";
  delivery: DeliveryStatus;
  detail: string | null;
}

export interface PushSubscriptionRecord {
  /** The push endpoint URL — stable per browser/device. */
  endpoint: string;
  keys: { p256dh: string; auth: string };
  label: string;
  createdAt: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  enabled: boolean;
}

export interface NotificationPreferences {
  master: boolean;
  severities: { critical: boolean; warning: boolean; info: boolean };
  categories: {
    "system-health": boolean;
    "docker-health": boolean;
    "docker-updates": boolean;
    storage: boolean;
    "beacon-updates": boolean;
    services: boolean;
    resolved: boolean;
    /** v1.6.0 (Fase 25): insights are NEVER pushed by default. Only a
     *  small opt-in class (capacity critical soon, extreme persistent
     *  degradation) is eligible, and only when this category is on. */
    insights: boolean;
  };
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  master: true,
  severities: { critical: true, warning: true, info: false },
  categories: {
    "system-health": true,
    "docker-health": true,
    "docker-updates": false,
    storage: true,
    "beacon-updates": false,
    services: true,
    resolved: false,
    insights: false,
  },
};

export interface NotificationState {
  version: 1;
  preferences: NotificationPreferences;
  active: Record<string, ActiveEvent>;
  subscriptions: PushSubscriptionRecord[];
  history: NotificationRecord[];
  /** Monotonic counter for history ids. */
  lastId: number;
  /**
   * When the initial baseline was taken. First-run/upgrade protection: on
   * a fresh state file the current conditions are ingested SILENTLY (no
   * dispatch) so activating notifications or upgrading from v1.1.x never
   * floods devices with pre-existing problems.
   */
  baselinedAt: number | null;
}

export function sanitizeNotificationText(value: string, max: number): string {
  // Notification payloads render as plain text in every OS surface; strip
  // control characters and hard-cap length so untrusted names cannot make
  // notifications unreadable or oversized.
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}
