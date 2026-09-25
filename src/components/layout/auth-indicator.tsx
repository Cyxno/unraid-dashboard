"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { UserRound } from "lucide-react";

interface AuthStatus {
  mode: "disabled" | "proxy";
  user: string | null;
  actionsEnabled: boolean;
}

/** Shows the signed-in identity in proxy mode; nothing in LAN mode. */
export function AuthIndicator() {
  const [status, setStatus] = useState<AuthStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/status", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data: AuthStatus | null) => {
        if (!cancelled && data) setStatus(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (!status || status.mode !== "proxy" || !status.user) return null;
  return (
    <Badge variant="muted" className="hidden gap-1 sm:inline-flex" title={`Authenticated via reverse proxy as ${status.user}`}>
      <UserRound className="size-3" aria-hidden="true" />
      {status.user}
    </Badge>
  );
}
