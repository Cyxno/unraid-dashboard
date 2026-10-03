"use client";

import { useEffect, useState } from "react";
import { Shield, ShieldCheck, ShieldAlert, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTimeIso } from "@/lib/utils";

/**
 * Settings → Security: auth mode, HTTPS state, credential status,
 * action capability, helper auth and push configuration in one card.
 */

interface SecurityStatus {
  authMode: "trusted" | "local" | "proxy";
  authModeSource: "env" | "ui" | "default";
  localUsername: string | null;
  localConfigured: boolean;
  unraidConfigured: boolean;
  unraidSource: string;
  actionKeyConfigured: boolean;
  helperConfigured: boolean;
  helperReachable: boolean | null;
  pushConfigured: boolean;
  vapidConfigured: boolean;
}

export function SecuritySection() {
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/security/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: SecurityStatus | null) => {
        if (body) setStatus(body);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const modeLabel =
    status?.authMode === "local"
      ? "Local login"
      : status?.authMode === "proxy"
        ? "Reverse proxy"
        : "Trusted network";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="size-4" aria-hidden="true" /> Security
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />}
        {status && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Authentication mode</span>
              <Badge variant={status.authMode === "trusted" ? "muted" : "success"}>
                {modeLabel}
                {status.authModeSource === "env" ? " (env)" : ""}
              </Badge>
            </div>
            {status.authMode === "trusted" && (
              <p className="text-[11px] text-muted-foreground">
                Anyone who can reach Beacon can access it. Restrict access via your
                network (Tailscale, firewall) or switch to Local login.
              </p>
            )}
            {status.authMode === "local" && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Local user</span>
                <span className="font-mono text-xs">{status.localUsername ?? "—"}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Unraid connection</span>
              {status.unraidConfigured ? (
                <Badge variant="success">configured ({status.unraidSource})</Badge>
              ) : (
                <Badge variant="warning">not configured</Badge>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Action key</span>
              {status.actionKeyConfigured ? (
                <Badge variant="success">configured</Badge>
              ) : (
                <Badge variant="muted">read-only mode</Badge>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Update helper</span>
              {status.helperConfigured ? (
                status.helperReachable ? (
                  <Badge variant="success">reachable</Badge>
                ) : (
                  <Badge variant="warning">unreachable</Badge>
                )
              ) : (
                <Badge variant="muted">not configured</Badge>
              )}
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Push notifications</span>
              {status.vapidConfigured ? (
                <Badge variant="success">configured</Badge>
              ) : (
                <Badge variant="muted">not configured</Badge>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
