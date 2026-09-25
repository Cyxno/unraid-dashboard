"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActionsCapabilities, ActionResponseBody } from "@/lib/api-types";

/**
 * Client-side action support: capabilities (server decides whether
 * actions exist at all), and a guarded POST helper with busy state.
 * No optimistic state — the UI only reflects server-verified results.
 */

export function useActionCapabilities(): {
  capabilities: ActionsCapabilities | null;
  refresh: () => void;
} {
  const [capabilities, setCapabilities] = useState<ActionsCapabilities | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/actions/status", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: ActionsCapabilities | null) => {
        if (!cancelled) setCapabilities(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { capabilities, refresh: useCallback(() => setTick((v) => v + 1), []) };
}

export type PendingAction = { kind: "docker" | "vm"; action: string; id: string } | null;

export function useActionRunner(
  onDone?: (result: ActionResponseBody) => void,
): {
  runAction: (request: NonNullable<PendingAction>) => Promise<ActionResponseBody | null>;
  pending: PendingAction;
  result: ActionResponseBody | null;
  clearResult: () => void;
} {
  const [pending, setPending] = useState<PendingAction>(null);
  const [result, setResult] = useState<ActionResponseBody | null>(null);

  const runAction = useCallback(
    async (request: NonNullable<PendingAction>): Promise<ActionResponseBody | null> => {
      setPending(request);
      setResult(null);
      try {
        const response = await fetch("/api/actions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
        });
        const body = (await response.json()) as ActionResponseBody;
        setResult(body);
        onDone?.(body);
        return body;
      } catch {
        const body: ActionResponseBody = {
          ok: false,
          status: "error",
          message: "Request failed — the dashboard server could not complete the action.",
        };
        setResult(body);
        onDone?.(body);
        return body;
      } finally {
        setPending(null);
      }
    },
    [onDone],
  );

  return { runAction, pending, result, clearResult: () => setResult(null) };
}
