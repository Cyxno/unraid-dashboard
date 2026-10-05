"use client";

import { useEffect, useState } from "react";
import { Database, Globe, Gauge, Bell, GitBranch, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Settings → Configuration: every runtime setting with its source
 * (ENV / UI / Default), effective value and editable status.
 * Source data comes from the same config store as the server uses —
 * no hardcoded UI list that diverges from runtime.
 */

interface SettingRow {
  key: string;
  label: string;
  category: string;
  value: string | null;
  source: "env" | "ui" | "default";
  secret: boolean;
  editable: boolean;
  restartRequired: boolean;
  testable?: boolean;
}

interface ConfigInventory {
  settings: SettingRow[];
}

const CATEGORY_ORDER = ["Unraid", "Metrics", "Helper", "Notifications", "Updates", "Networking / Advanced"] as const;

const CATEGORY_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "Unraid": Database,
  "Metrics": Gauge,
  "Helper": GitBranch,
  "Notifications": Bell,
  "Updates": GitBranch,
  "Networking / Advanced": Globe,
};

function SourceBadge({ source }: { source: SettingRow["source"] }) {
  if (source === "env") {
    return <Badge variant="warning" className="text-[10px]" title="Managed by environment — UI writes are ignored while the env var exists">ENV</Badge>;
  }
  if (source === "ui") return <Badge variant="success" className="text-[10px]">UI</Badge>;
  return <Badge variant="muted" className="text-[10px]">default</Badge>;
}

export function ConfigurationSection() {
  const [settings, setSettings] = useState<SettingRow[] | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch("/api/config/inventory", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: ConfigInventory | null) => {
        if (body?.settings) setSettings(body.settings);
      })
      .catch(() => {});
  }, []);

  const testConnection = async (key: string) => {
    setTesting(key);
    try {
      const res = await fetch(`/api/config/test-connection?key=${encodeURIComponent(key)}`, { method: "POST" });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; detail?: string } | null;
      setTestResult((prev) => ({ ...prev, [key]: body?.ok ? "✓ Connected" : `✗ ${body?.detail ?? "Failed"}` }));
    } catch {
      setTestResult((prev) => ({ ...prev, [key]: "✗ Network error" }));
    } finally {
      setTesting(null);
    }
  };

  if (!settings) return null;

  const categories = [...new Set(settings.map((s) => s.category))].sort(
    (a, b) => (CATEGORY_ORDER as readonly string[]).indexOf(a) - (CATEGORY_ORDER as readonly string[]).indexOf(b),
  );

  return (
    <div className="space-y-6">
      {categories.map((category) => {
        const rows = settings.filter((s) => s.category === category);
        const Icon = CATEGORY_ICONS[category] ?? Database;
        return (
          <div key={category}>
            <h3 className="mb-2 mt-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {Icon && <Icon className="size-3.5" aria-hidden="true" />} {category}
            </h3>
            <div className="space-y-1.5">
              {rows.map((row) => (
                <div key={row.key} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-[180px] text-muted-foreground">{row.label}</span>
                  {row.value !== null ? (
                    <span className={cn("font-mono text-xs", row.secret && "select-none blur-sm hover:blur-none")} title={row.secret ? "Secret — click to reveal" : undefined}>
                      {row.secret ? "••••••••" : row.value}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  <SourceBadge source={row.source} />
                  {row.restartRequired && <Badge variant="warning" className="text-[10px]">restart</Badge>}
                  {row.testable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-auto h-6 gap-1 text-xs"
                      disabled={testing === row.key}
                      onClick={() => void testConnection(row.key)}
                    >
                      {testing === row.key && <Loader2 className="size-3 animate-spin" aria-hidden="true" />}
                      Test
                    </Button>
                  )}
                  {testResult[row.key] && <span className="text-[11px] text-muted-foreground">{testResult[row.key]}</span>}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

