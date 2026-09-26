"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { setBusyScope } from "@/lib/busy-guard";

/**
 * Accessible confirmation dialog (focus trap, Escape closes, role=dialog).
 * Deliberately not browser confirm() — needs real content and styling.
 */

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  /** Visual weight: start=light, restart=medium, stop=strong. */
  severity?: "info" | "warning" | "destructive";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const SEVERITY_STYLES = {
  info: { button: "secondary" as const, border: "border", icon: "text-muted-foreground" },
  warning: { button: "warning" as const, border: "border-warning/40", icon: "text-warning" },
  destructive: { button: "destructive" as const, border: "border-destructive/40", icon: "text-destructive" },
};

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  severity = "warning",
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // An open confirmation dialog blocks deferred refreshes/activations.
    setBusyScope("confirm-dialog", true);
    const previousFocus = document.activeElement as HTMLElement | null;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) onCancel();
        return;
      }
      if (event.key === "Tab" && dialogRef.current) {
        // Minimal focus trap.
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      setBusyScope("confirm-dialog", false);
      previousFocus?.focus?.();
    };
  }, [open, busy, onCancel]);

  // The dialog only opens from user interaction (post-hydration), so the
  // document is always available when `open` is true.
  if (!open || typeof document === "undefined") return null;
  const styles = SEVERITY_STYLES[severity];

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Cancel action"
        onClick={() => !busy && onCancel()}
        className="absolute inset-0 bg-black/60"
        tabIndex={-1}
      />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative w-full max-w-md rounded-lg border bg-card p-5 shadow-xl",
          styles.border,
        )}
      >
        <p className="flex items-center gap-2 text-sm font-semibold">
          <TriangleAlert className={cn("size-4", styles.icon)} aria-hidden="true" />
          {title}
        </p>
        <div className="mt-2 space-y-1.5 text-sm text-muted-foreground">{children}</div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            ref={confirmRef}
            variant={styles.button}
            size="sm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
