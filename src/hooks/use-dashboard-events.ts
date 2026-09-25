"use client";

import { useEffect, useRef, useState } from "react";

/**
 * SSE client with automatic reconnection (bounded backoff) and a
 * visibility guard for sleep/wake. The dashboard never DEPENDS on SSE:
 * callers keep their polling and treat this as an accelerator.
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
}

export function useDashboardEvents(
  onEvent?: (event: keyof DashboardEvents & string, data: unknown) => void,
): SseStatus {
  const [status, setStatus] = useState<SseStatus>("connecting");
  const handlerRef = useRef(onEvent);

  useEffect(() => {
    // Keep the latest handler without re-subscribing the EventSource.
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry = 0;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      setStatus((current) => (current === "connected" ? current : retry === 0 ? "connecting" : "reconnecting"));
      source = new EventSource("/api/events");

      source.onopen = () => {
        retry = 0;
        setStatus("connected");
      };

      source.onerror = () => {
        source?.close();
        source = null;
        if (closed) return;
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
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisible);
      source?.close();
    };
  }, []);

  return status;
}
