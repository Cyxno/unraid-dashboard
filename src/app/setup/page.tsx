"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BeaconMark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle2, ArrowRight, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * First-time setup wizard (v1.3.0).
 *
 * Requires the one-time setup token from /app/data/setup-token.txt
 * (0600, host-generated). The claim is atomic: once completed, the
 * wizard is locked and further attempts return 409.
 */

interface SetupStatus {
  state: "unconfigured" | "configured";
  tokenPresent: boolean;
  version: string;
}

type Step = 0 | 1 | 2 | 3;

export default function SetupPage() {
  const router = useRouter();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState<Step>(0);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [token, setToken] = useState("");
  const [unraidUrl, setUnraidUrl] = useState("http://127.0.0.1:442");
  const [unraidApiKey, setUnraidApiKey] = useState("");
  const [prometheusUrl] = useState("");
  const [securityMode, setSecurityMode] = useState<"trusted" | "local">("trusted");
  const [localUsername, setLocalUsername] = useState("");
  const [localPassword, setLocalPassword] = useState("");

  useEffect(() => {
    fetch("/api/setup/status", { cache: "no-store" })
      .then((res) => res.json())
      .then((body: SetupStatus) => {
        setStatus(body);
        if (body.state === "configured") router.replace("/");
      })
      .catch(() => setError("Could not reach Beacon."));
  }, [router]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/setup/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          unraidUrl,
          unraidApiKey,
          prometheusUrl: prometheusUrl || undefined,
          securityMode,
          localUsername: securityMode === "local" ? localUsername : undefined,
          localPassword: securityMode === "local" ? localPassword : undefined,
        }),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !body?.ok) {
        setError(body?.error ?? `Setup failed (HTTP ${res.status}).`);
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Network error during setup.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!status) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden="true" />
      </div>
    );
  }

  if (status.state === "configured") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="max-w-sm space-y-4 text-center">
          <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden="true" />
          <h1 className="text-lg font-semibold">Beacon is already configured</h1>
          <p className="text-sm text-muted-foreground">
            The setup wizard is a one-time process. Go to the dashboard to continue.
          </p>
          <Button onClick={() => router.push("/")}>Go to dashboard</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-lg space-y-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <BeaconMark className="size-14 rounded-xl" />
          <h1 className="text-xl font-semibold tracking-tight">Welcome to Beacon</h1>
          <p className="text-sm text-muted-foreground">
            {status.version !== "unknown" ? `v${status.version} · ` : ""}
            Set up your Unraid dashboard — this is a one-time process.
          </p>
        </div>

        {error && (
          <p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}

        <div className="rounded-xl border bg-card p-5 shadow-card">
          {/* Step 0: Setup token */}
          {step === 0 && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold">Security token</h2>
              <p className="text-xs text-muted-foreground">
                Enter the setup token from <code className="rounded bg-muted px-1">/app/data/setup-token.txt</code> on
                your Unraid host (or container console: <code className="rounded bg-muted px-1">cat /app/data/setup-token.txt</code>).
                This proves you have host access — nobody on the network can claim setup without it.
              </p>
              <input
                type="text"
                placeholder="Setup token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="w-full rounded-lg border bg-transparent px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
                autoComplete="off"
              />
              <Button className="w-full" disabled={!token.trim()} onClick={() => setStep(1)}>
                Continue <ArrowRight className="ml-1 size-3.5" aria-hidden="true" />
              </Button>
            </div>
          )}

          {/* Step 1: Unraid connection */}
          {step === 1 && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold">Connect to Unraid</h2>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Unraid API URL</label>
                <input
                  type="url"
                  value={unraidUrl}
                  onChange={(e) => setUnraidUrl(e.target.value)}
                  className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder="http://127.0.0.1:442"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Default: <code>http://127.0.0.1:442</code> (Unraid 7.x built-in GraphQL API)
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Unraid API key</label>
                <input
                  type="password"
                  value={unraidApiKey}
                  onChange={(e) => setUnraidApiKey(e.target.value)}
                  className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Read-only API key"
                  autoComplete="off"
                />
              </div>
              <div className="flex justify-between">
                <Button variant="ghost" size="sm" onClick={() => setStep(0)}>
                  <ArrowLeft className="mr-1 size-3.5" aria-hidden="true" /> Back
                </Button>
                <Button disabled={!unraidApiKey.trim()} onClick={() => setStep(2)}>
                  Continue <ArrowRight className="ml-1 size-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 2: Security */}
          {step === 2 && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold">Security</h2>
              <p className="text-xs text-muted-foreground">
                Choose how Beacon controls access. You can change this later in Settings → Security.
              </p>
              {(
                [
                  ["trusted", "Trusted network", "No built-in login. Anyone who can reach Beacon (LAN or Tailscale) can access it."],
                  ["local", "Local login", "Protect Beacon with a username and password. Works on any network."],
                ] as const
              ).map(([value, label, description]) => (
                <label
                  key={value}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3",
                    securityMode === value ? "border-primary bg-primary/5" : "hover:bg-secondary/50",
                  )}
                >
                  <input
                    type="radio"
                    name="securityMode"
                    value={value}
                    checked={securityMode === value}
                    onChange={() => setSecurityMode(value)}
                    className="mt-0.5 accent-[var(--primary)]"
                  />
                  <span>
                    <span className="block text-sm font-medium">{label}</span>
                    <span className="block text-xs text-muted-foreground">{description}</span>
                  </span>
                </label>
              ))}
              {securityMode === "local" && (
                <div className="space-y-2 rounded-lg border p-3">
                  <input
                    type="text"
                    placeholder="Username"
                    value={localUsername}
                    onChange={(e) => setLocalUsername(e.target.value)}
                    className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    autoComplete="username"
                  />
                  <input
                    type="password"
                    placeholder="Password (min 10 characters)"
                    value={localPassword}
                    onChange={(e) => setLocalPassword(e.target.value)}
                    className="w-full rounded-lg border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    autoComplete="new-password"
                  />
                  {localPassword.length > 0 && localPassword.length < 10 && (
                    <p className="text-xs text-destructive">Password must be at least 10 characters.</p>
                  )}
                </div>
              )}
              <div className="flex justify-between">
                <Button variant="ghost" size="sm" onClick={() => setStep(1)}>
                  <ArrowLeft className="mr-1 size-3.5" aria-hidden="true" /> Back
                </Button>
                <Button
                  disabled={securityMode === "local" && (!localUsername.trim() || localPassword.length < 10)}
                  onClick={() => setStep(3)}
                >
                  Review <ArrowRight className="ml-1 size-3.5" aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}

          {/* Step 3: Review + finish */}
          {step === 3 && (
            <div className="space-y-4">
              <h2 className="text-sm font-semibold">Review</h2>
              <dl className="space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between"><dt>Unraid API</dt><dd className="font-mono">{unraidUrl}</dd></div>
                <div className="flex justify-between"><dt>Security</dt><dd>{securityMode === "local" ? `Local login (${localUsername})` : "Trusted network"}</dd></div>
              </dl>
              <p className="text-[11px] text-muted-foreground">
                Your API key is stored server-side only and never sent to the browser.
                You can configure Prometheus, the update helper and push notifications
                later in Settings.
              </p>
              <div className="flex justify-between">
                <Button variant="ghost" size="sm" onClick={() => setStep(2)}>
                  <ArrowLeft className="mr-1 size-3.5" aria-hidden="true" /> Back
                </Button>
                <Button disabled={submitting} onClick={() => void submit()}>
                  {submitting && <Loader2 className="mr-1 size-3.5 animate-spin" aria-hidden="true" />}
                  Finish setup
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

