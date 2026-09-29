"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useDashboardEvents, type SseStatus } from "@/hooks/use-dashboard-events";
import { useToast } from "./toast";

/**
 * Consumes the shared SSE stream once for the whole app:
 * - exposes connection status + latest snapshot to any component
 * - raises restrained toasts for connection changes and observed
 *   container state transitions (never for metric updates)
 * - the dashboard keeps polling regardless; SSE only accelerates
 */

export interface UpdatePhaseEvent {
  phase: string;
  detail: string | null;
  finishedAt: string | null;
}

export interface AutomationEvent {
  evaluatedAt: string;
  enabled: boolean;
  paused: boolean;
  queueLength: number;
  windowOpen: boolean;
  eligible: number;
  cooldown: number;
  intervention: number;
  targets: Array<{ name: string; state: string; optIn: boolean }>;
}

export interface LiveState {
  status: SseStatus;
  snapshot: {
    cpuPercent: number | null;
    memoryPercent: number | null;
    load5: number | null;
    packageC: number | null;
    hottest: string | null;
  } | null;
  dockerCounts: { running: number; total: number } | null;
  /** Latest update-machine phase (v0.7); null when none observed. */
  updatePhase: UpdatePhaseEvent | null;
  /** Latest automation evaluation (v0.9.3); null until scheduler ticks. */
  automation: AutomationEvent | null;
}

const LiveContext = createContext<LiveState>({ status: "connecting", snapshot: null, dockerCounts: null, updatePhase: null, automation: null });

export function useLive(): LiveState {
  return useContext(LiveContext);
}

export function LiveEventsProvider({ children }: { children: React.ReactNode }) {
  const [snapshot, setSnapshot] = useState<LiveState["snapshot"]>(null);
  const [dockerCounts, setDockerCounts] = useState<LiveState["dockerCounts"]>(null);
  const [updatePhase, setUpdatePhase] = useState<UpdatePhaseEvent | null>(null);
  const [automation, setAutomation] = useState<AutomationEvent | null>(null);
  const statusRef = useRef<SseStatus>("connecting");
  const everConnected = useRef(false);
  const { toast } = useToast();

  const onEvent = (name: string, data: unknown) => {
    if (name === "snapshot") {
      setSnapshot(data as LiveState["snapshot"]);
    } else if (name === "docker") {
      setDockerCounts(data as LiveState["dockerCounts"]);
    } else if (name === "automation") {
      setAutomation(data as AutomationEvent);
    } else if (name === "update") {
      const phase = data as UpdatePhaseEvent;
      setUpdatePhase(phase);
      // One restrained toast per settled outcome, not per phase.
      if (phase.phase === "complete") {
        toast("success", "Dashboard update complete — refreshing is safe");
      } else if (phase.phase === "failed") {
        toast("error", `Dashboard update failed${phase.detail ? `: ${phase.detail}` : ""}`);
      }
    } else if (name === "state-transition") {
      const transition = data as { name: string; from: string; to: string };
      // Subtle, factual — one line per observed change.
      toast(
        transition.to === "RUNNING" ? "success" : "connection",
        `${transition.name}: ${transition.from.toLowerCase()} → ${transition.to.toLowerCase()}`,
      );
    }
  };

  const status = useDashboardEvents((name, data) => {
    onEvent(name, data);
  });

  // Surface connection degradation/recovery exactly once per incident.
  useEffect(() => {
    const previous = statusRef.current;
    statusRef.current = status;
    if (status === "connected") {
      if (!everConnected.current) {
        everConnected.current = true;
      } else if (previous === "reconnecting" || previous === "offline") {
        toast("connection", "Live connection restored");
      }
    } else if (previous === "connected" && (status === "reconnecting" || status === "offline")) {
      everConnected.current = true;
      toast("connection", "Live connection lost — polling continues");
    }
  }, [status, toast]);

  return (
    <LiveContext.Provider value={{ status, snapshot, dockerCounts, updatePhase, automation }}>
      {children}
    </LiveContext.Provider>
  );
}
