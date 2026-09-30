"use client";

import { useCallback, useRef, useState } from "react";
import { useActionRunner } from "@/components/actions/use-actions";
import { useToast } from "@/components/layout/toast";
import { useDashboardEvents } from "@/hooks/use-dashboard-events";
import { normalizeActionCapabilities, type RawActionStatus } from "@/lib/action-capabilities";
import { useEffect } from "react";

/**
 * Shared Docker lifecycle action controller (v0.9.10) — the ONE
 * implementation of confirm → request → transition → SSE confirmation →
 * polling fallback → timeout → feedback. The Docker list cards and the
 * container detail page both consume this; no page defines its own action
 * semantics anymore.
 *
 * Restart is intentionally absent everywhere: the live Unraid API exposes
 * docker start/stop/pause/unpause only (probed v0.9.9). Pause/unpause were
 * evaluated (v0.9.10) and left unsupported — no compelling operator use
 * case on a headless dashboard.
 *
 * State machine per action:
 *   requested → stopping | starting → verifying → success | failed | timeout
 * Completion waits for the docker `state-transition` SSE event and falls
 * back to a bounded /api/docker poll — never a fixed sleep.
 */

export type DockerActionName = "start" | "stop";

export interface DockerActionRequest {
  id: string;
  name: string;
  action: DockerActionName;
}

export interface DockerActionPhase {
  id: string;
  name: string;
  action: DockerActionName;
  state: "requested" | "stopping" | "starting" | "verifying" | "timeout";
  label: string;
  timedOut: boolean;
}

export interface DockerActionResult {
  ok: boolean;
  message: string;
  action: DockerActionName;
  name: string;
  /** How completion was actually confirmed (diagnostics, surfaced in QA). */
  via: "sse" | "poll" | null;
}

const STOP_TIMEOUT_MS = 45_000;
const START_TIMEOUT_MS = 90_000;

export function actionTimeoutMs(action: DockerActionName): number {
  return action === "stop" ? STOP_TIMEOUT_MS : START_TIMEOUT_MS;
}

export function useDockerAction() {
  const { runAction, pending, result: rawResult } = useActionRunner();
  const { toast } = useToast();
  const [pendingConfirm, setPendingConfirm] = useState<DockerActionRequest | null>(null);
  const [phase, setPhase] = useState<DockerActionPhase | null>(null);
  const [result, setResult] = useState<DockerActionResult | null>(null);
  const transitionWaiters = useRef(
    new Map<string, { expected: string; resolve: (via: "sse" | "poll" | null) => void }>(),
  );

  const sseStatus = useDashboardEvents((eventName, data) => {
    if (eventName !== "state-transition") return;
    const event = data as { name: string; to: string };
    const waiter = transitionWaiters.current.get(event.name);
    if (waiter && event.to === waiter.expected) {
      transitionWaiters.current.delete(event.name);
      waiter.resolve("sse");
    }
  });
  void sseStatus;

  // Raw capability normalization in one place (the API stays authoritative).
  const [caps, setCaps] = useState<ReturnType<typeof normalizeActionCapabilities> | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/actions/status", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<RawActionStatus>) : null))
      .then((status) => {
        if (!cancelled) setCaps(normalizeActionCapabilities(status));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** Opens the confirmation step (each page renders its own dialog body). */
  const begin = useCallback((request: DockerActionRequest) => setPendingConfirm(request), []);
  const cancel = useCallback(() => setPendingConfirm(null), []);

  const waitForTransition = useCallback(
    (containerName: string, expected: string, timeoutMs: number): Promise<"sse" | "poll" | null> =>
      new Promise((resolve) => {
        let settled = false;
        let via: "sse" | "poll" | null = null;
        const deadline = Date.now() + timeoutMs;
        const done = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearInterval(timer);
          transitionWaiters.current.delete(containerName);
          resolve(ok ? via : null);
        };
        const timer = setInterval(async () => {
          if (Date.now() >= deadline) return done(false);
          try {
            const response = await fetch("/api/docker", { cache: "no-store" });
            const body = (await response.json()) as {
              data?: { containers?: Array<{ name: string; state: string }> };
            };
            const container = body.data?.containers?.find((c) => c.name === containerName);
            if (container?.state === expected) {
              via = "poll"; // SSE may still have fired first; poll observed it
              done(true);
            }
          } catch {
            // transient — retry until the deadline
          }
        }, 2_000);
        transitionWaiters.current.set(containerName, {
          expected,
          resolve: (source) => {
            via = source;
            done(true);
          },
        });
      }),
    [],
  );

  /** Runs the confirmed action through the full state machine. */
  const confirm = useCallback(
    async (override?: DockerActionRequest) => {
      const request = override ?? pendingConfirm;
      if (!request) return;
      setPendingConfirm(null);
      const expected = request.action === "stop" ? "EXITED" : "RUNNING";
      const timeoutMs = actionTimeoutMs(request.action);
      setPhase({
        id: request.id,
        name: request.name,
        action: request.action,
        state: "requested",
        label: request.action === "stop" ? "stopping…" : "starting…",
        timedOut: false,
      });
      const result = await runAction({ kind: "docker", action: request.action, id: request.id });
      if (!result?.ok) {
        setPhase(null);
        setResult({
          ok: false,
          message: result?.message ?? `${request.name}: ${request.action} failed`,
          action: request.action,
          name: request.name,
          via: null,
        });
        toast("error", result?.message ?? `${request.name}: ${request.action} failed`);
        return;
      }
      setPhase((current) =>
        current && current.id === request.id
          ? { ...current, state: request.action === "stop" ? "stopping" : "starting", label: current.label }
          : current,
      );
      const via = await waitForTransition(request.name, expected, timeoutMs);
      if (via) {
        setPhase(null);
        setResult({
          ok: true,
          message: `${request.name}: ${request.action} verified (${expected.toLowerCase()})`,
          action: request.action,
          name: request.name,
          via,
        });
        toast("success", `${request.name}: ${request.action} verified (${expected.toLowerCase()})`);
      } else {
        setPhase({
          id: request.id,
          name: request.name,
          action: request.action,
          state: "timeout",
          label: `no ${expected.toLowerCase()} within ${Math.round(timeoutMs / 1000)}s`,
          timedOut: true,
        });
        setResult({
          ok: false,
          message: `${request.name}: ${request.action} accepted but not verified within ${Math.round(timeoutMs / 1000)}s`,
          action: request.action,
          name: request.name,
          via: null,
        });
        toast(
          "error",
          `${request.name}: ${request.action} accepted but not verified within ${Math.round(timeoutMs / 1000)}s — check the container`,
        );
        setTimeout(() => setPhase(null), 10_000);
      }
    },
    [pendingConfirm, runAction, toast, waitForTransition],
  );

  return {
    /** Normalized capabilities from /api/actions/status (authoritative). */
    caps,
    /** Confirmation-step state; pages render the dialog. */
    pendingConfirm,
    begin,
    cancel,
    /** Runs the confirmed request through the state machine. */
    confirm,
    /** POST in flight (from the guarded action runner). */
    posting: pending !== null,
    /** Verifiable transition phase, null when idle. */
    phase,
    /** Final outcome (also toasted) for pages that show it inline. */
    result,
  };
}
