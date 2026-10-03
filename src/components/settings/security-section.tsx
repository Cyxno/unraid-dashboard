"use client";

import { useEffect, useState } from "react";
import { Shield, ShieldCheck, ShieldAlert, Loader2, LogOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTimeIso } from "@/lib/utils";

/**
 * Settings → Security: auth mode, HTTPS state, credential status,
 * action capability, helper auth and push configuration in one card.
 * Local-auth devices can log out or sign out all devices.
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
  const [signingOut, setSigningOut] = useState(false);
  const [signOutAll, setSignOutAll] = useState(false);

  useEffect(() => {
    fetch("/api/security/status", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: SecurityStatus | null) => {
        if (body) setStatus(body);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const doLogout = async () => {
    setSigningOut(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  };

  const doLogoutAll = async () => {
    setSigningOut(true);
    await fetch("/api/auth/logout-all", { method: "POST" }).catch(() => {});
    window.location.href = "/login";
  };

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
            {status.authMode === "local" && (
              <div className="flex gap-2 pt-1 border-t">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={signingOut}
                  onClick={() => void doLogout()}
                >
                  {signingOut ? <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden="true" /> : <LogOut className="mr-1 size-3.5" aria-hidden="true" />}
                  Log out
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={signingOut}
                  onClick={() => {
                    if (window.confirm("Sign out all devices? Every browser will need to log in again.")) void doLogoutAll();
                  }}
                >
                  <LogOutAll className="mr-1 size-3.5" aria-hidden="true" />
                  Sign out all devices
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function LogOutAll(props: React.ComponentProps<"svg">) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="m16 16 5-5-4-4" />
      <path d="m21 11h-8" />
    </svg>
  );
}
