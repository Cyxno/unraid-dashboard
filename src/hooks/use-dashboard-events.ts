"use client";

import { useEffect, useRef, useState } from "react";
import { usePwa } from "@/components/layout/pwa-provider";
import { isAuthExpired } from "@/lib/auth-state";

/**
 * SSE client with automatic reconnection (bounded backoff) and a
 * visibility guard for sleep/wake. The dashboard never DEPENDS on SSE:
 * callers keep their polling and treat this as an accelerator.
 *
 * While the browser is offline the stream is closed instead of retried —
 * EventSource's own retry would otherwise hammer a dead network. The
 * browser's `online` event resumes it immediately.
 */

export type SseStatus = "connecting" | "connected" | "reconnecting" | "offline";

export interface DashboardEvents {
  snapshot?: {
    cpuPercent: number | null;
    memoryPercent: number | null;
    load5: number | null;
    packageC: number | null;
    hottest: string | null;
  };
  docker?: { running: number; total: number };
  health?: { level: string | null; reasons: string[] };
  notifications?: { info: number; warning: number; alert: number };
  "state-transition"?: { name: string; from: string; to: string; at: string };
  hello?: { transitions: Array<{ name: string; from: string; to: string; at: string }> };
  /** v0.7: update-machine phase changes from the local helper. */
  update?: { phase: string; detail: string | null; finishedAt: string | null };
  /** v0.9.3: compact automation evaluation snapshot from the scheduler. */
  automation?: {
    evaluatedAt: string;
    enabled: boolean;
    paused: boolean;
    queueLength: number;
    windowOpen: boolean;
    eligible: number;
    cooldown: number;
    intervention: number;
    targets: Array<{ name: string; state: string; optIn: boolean }>;
  };
  /** v1.2.0: a notification was dispatched by the notification engine. */
  notification?: {
    id: number;
    severity: string;
    title: string;
    body: string;
    url: string;
    kind: string;
  };
}

export function useDashboardEvents(
  onEvent?: (event: keyof DashboardEvents & string, data: unknown) => void,
): SseStatus {
  const [status, setStatus] = useState<SseStatus>("connecting");
  const handlerRef = useRef(onEvent);
  const { online } = usePwa();

  useEffect(() => {
    // Keep the latest handler without re-subscribing the EventSource.
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry = 0;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearSource = () => {
      source?.close();
      source = null;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const connect = () => {
      if (disposed) return;
      if (!navigator.onLine) {
        // Offline: no EventSource, no retries — the `online` event resumes.
        clearSource();
        setStatus("offline");
        return;
      }
      if (isAuthExpired()) {
        // Session expired: no stream, no retries — the auth overlay's
        // probe reloads the page on recovery.
        clearSource();
        setStatus("offline");
        return;
      }
      setStatus((current) =>
        current === "connected" ? current : retry === 0 ? "connecting" : "reconnecting",
      );
      source = new EventSource("/api/events");

      source.onopen = () => {
        retry = 0;
        setStatus("connected");
      };

      source.onerror = () => {
        source?.close();
        source = null;
        if (disposed) return;
        setStatus("reconnecting");
        // Bounded backoff: 1s, 2s, 4s … capped at 30s.
        const delay = Math.min(30_000, 1000 * 2 ** retry);
        retry += 1;
        retryTimer = setTimeout(connect, delay);
      };

      const forward =
        (eventName: keyof DashboardEvents & string) =>
        (event: MessageEvent) => {
          try {
            handlerRef.current?.(eventName, JSON.parse(event.data));
          } catch {
            // malformed event — ignore
          }
        };
      const names: Array<keyof DashboardEvents & string> = [
        "snapshot",
        "docker",
        "health",
        "notifications",
        "state-transition",
        "hello",
        "update",
        "notification",
      ];
      for (const name of names) {
        source.addEventListener(name, forward(name) as EventListener);
      }
    };

    connect();

    // Sleep/wake: EventSource usually recovers, but force a clean retry
    // if the connection died while the device slept.
    const onVisible = () => {
      if (document.visibilityState === "visible" && source?.readyState === EventSource.CLOSED) {
        retry = 0;
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      disposed = true;
      clearSource();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [online]);

  return status;
}
