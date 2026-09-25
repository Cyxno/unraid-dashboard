"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, WifiOff, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Restrained toast system: action results and connection changes only —
 * never per-metric updates. Positioned above the bottom nav on phones
 * (bottom-anchored with safe-area + nav clearance on mobile, top on
 * desktop) and auto-dismisses.
 */

export type ToastKind = "success" | "error" | "connection";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  toast: (kind: ToastKind, message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const ICONS = {
  success: CheckCircle2,
  error: XCircle,
  connection: WifiOff,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  // Portal content is client-only; render after hydration to match SSR.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- post-hydration portal mount
    setMounted(true);
  }, []);

  const toast = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setToasts((current) => [...current.slice(-2), { id, kind, message }]);
    setTimeout(() => {
      setToasts((current) => current.filter((entry) => entry.id !== id));
    }, kind === "connection" ? 6_000 : 4_000);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} mounted={mounted} />
    </ToastContext.Provider>
  );
}

function ToastViewport({ toasts, mounted }: { toasts: Toast[]; mounted: boolean }) {
  if (!mounted || typeof document === "undefined" || toasts.length === 0) return null;
  return createPortal(
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-[90] flex flex-col items-center gap-2 px-4 md:bottom-6 md:right-6 md:left-auto md:items-end"
    >
      {toasts.map((entry) => {
        const Icon = ICONS[entry.kind];
        return (
          <div
            key={entry.id}
            role={entry.kind === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex w-full max-w-sm items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-sm shadow-lg backdrop-blur",
              entry.kind === "success" && "border-success/40 bg-success/10 text-success",
              entry.kind === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
              entry.kind === "connection" && "border-warning/40 bg-warning/10 text-warning",
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{entry.message}</span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast must be used within ToastProvider");
  return context;
}
