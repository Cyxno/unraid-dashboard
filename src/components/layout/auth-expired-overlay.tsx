"use client";

import { useEffect, useState } from "react";
import { KeyRound, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { onAuthChange, isAuthExpired, probeAuthAlive } from "@/lib/auth-state";

/**
 * Full-screen "Authentication required" state.
 *
 * Rendered inside the app shell when the proxy session has expired:
 * polling loops are paused, the last-known UI is replaced by one clear
 * card, and a 10-second probe auto-recovers the app the moment the
 * session is valid again (after the user re-authenticates in another
 * tab/window). No blank white screens, no retry storms.
 */

const PROBE_INTERVAL_MS = 10_000;

export function AuthExpiredOverlay() {
  const [expired, setExpired] = useState(isAuthExpired());
  const [checking, setChecking] = useState(false);

  useEffect(() => onAuthChange(() => setExpired(isAuthExpired())), []);

  useEffect(() => {
    if (!expired) return;
    let cancelled = false;
    const probe = async () => {
      setChecking(true);
      const alive = await probeAuthAlive();
      setChecking(false);
      if (!cancelled && alive) {
        // Session restored — reload once so every hook re-subscribes cleanly.
        window.location.reload();
      }
    };
    void probe();
    const timer = setInterval(probe, PROBE_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [expired]);

  if (!expired) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-lg border border-warning/40 bg-card p-6 text-center shadow-xl">
        <KeyRound className="mx-auto size-8 text-warning" aria-hidden="true" />
        <h1 className="mt-3 text-lg font-semibold">Authentication required</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your dashboard session has expired. Sign in again through your
          single sign-on portal — live data stays paused until then.
          Open boards resume automatically once the session is valid again.
        </p>
        <div className="mt-4 flex flex-col items-center gap-2">
          <Button
            size="sm"
            onClick={() => {
              void probeAuthAlive().then((alive) => {
                if (alive) window.location.reload();
              });
            }}
            disabled={checking}
          >
            <RefreshCw className={cn(checking && "animate-spin")} aria-hidden="true" />
            {checking ? "Checking…" : "I've signed in — check again"}
          </Button>
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">
          Tip for always-on displays: use “Remember me” on your sign-in
          portal to stay signed in longer.
        </p>
      </div>
    </div>
  );
}

