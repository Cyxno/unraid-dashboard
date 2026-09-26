"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, Download, FolderDown, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/components/layout/toast";
import { usePwa } from "@/components/layout/pwa-provider";
import {
  buildExportPayload,
  downloadDashboardExport,
  fetchDashboards,
  importDashboards,
} from "@/lib/dashboards";
import { formatBytes, formatDateTimeIso } from "@/lib/utils";
import type { DashboardListPayload } from "@/lib/api-types";

interface ServerBackup {
  file: string;
  bytes: number;
  createdAt: string;
}

/**
 * Settings → Dashboards: shared-dashboard management surface.
 * - Export downloads the shared layouts as sanitized JSON (no secrets exist
 *   in the schema).
 * - Import posts a file to the validated import endpoint; unknown fields
 *   are stripped server-side, oversize/invalid files are rejected.
 */
export function DashboardsSection() {
  const { online } = usePwa();
  const { toast } = useToast();
  const [list, setList] = useState<DashboardListPayload | null>(null);
  const [backups, setBackups] = useState<ServerBackup[]>([]);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setList(await fetchDashboards());
    } catch {
      // List stays null; the card renders a plain unavailable note.
    }
    try {
      const response = await fetch("/api/dashboards/backup", { cache: "no-store" });
      if (response.ok) {
        const body = (await response.json()) as { backups: ServerBackup[] };
        setBackups(body.backups ?? []);
      }
    } catch {
      setBackups([]);
    }
  }, []);

  useEffect(() => {
    // Data fetch on mount; setState happens post-await inside load().
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const onImportFile = async (file: File) => {
    if (file.size > 512 * 1024) {
      toast("error", "Import file too large (max 512 KB).");
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      const result = await importDashboards(JSON.parse(text));
      const rejectedNote = result.rejected.length > 0 ? `, ${result.rejected.length} rejected` : "";
      toast("success", `Imported ${result.imported.length} dashboard(s)${rejectedNote}`);
      await load();
    } catch (error) {
      toast("error", error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderDown className="size-4 text-muted-foreground" aria-hidden="true" />
          Shared dashboards
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-1 text-sm">
        {list ? (
          <>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Stored on server</span>
              <dd className="flex items-center gap-2">
                <Badge variant="muted">{list.dashboards.length} dashboard(s)</Badge>
                {list.invalid.length > 0 && (
                  <Badge variant="warning" title={list.invalid.join(", ")}>
                    {list.invalid.length} invalid file(s)
                  </Badge>
                )}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <span className="text-muted-foreground">Ownership</span>
              <span className="text-xs">
                {list.identity.mode === "proxy" ? (
                  <>signed in as <strong>{list.identity.user ?? "unknown"}</strong></>
                ) : (
                  "trusted-LAN shared resources (no per-user accounts)"
                )}
              </span>
            </div>
            {list.dashboards.length > 0 && (
              <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md border p-2 text-xs">
                {list.dashboards.slice(0, 12).map((dashboard) => (
                  <li key={dashboard.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 truncate">{dashboard.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatDateTimeIso(dashboard.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">Shared dashboard storage unavailable.</p>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            disabled={!list || list.dashboards.length === 0}
            onClick={() => list && downloadDashboardExport(list.dashboards)}
          >
            <Download aria-hidden="true" /> Export all
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !online}
            onClick={() => fileInput.current?.click()}
          >
            <Upload aria-hidden="true" /> Import JSON
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || !online}
            onClick={async () => {
              setBusy(true);
              try {
                const response = await fetch("/api/dashboards/backup", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({}),
                });
                const body = (await response.json().catch(() => ({}))) as { backup?: string; error?: string };
                if (response.ok) {
                  toast("success", `Server backup created (${body.backup})`);
                  await load();
                } else {
                  toast("error", body.error ?? "Backup failed");
                }
              } finally {
                setBusy(false);
              }
            }}
          >
            <Archive aria-hidden="true" /> Server backup
          </Button>
          <input
            ref={fileInput}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label="Import dashboards from JSON file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void onImportFile(file);
            }}
          />
        </div>

        {backups.length > 0 && (
          <div className="rounded-md border p-2 text-xs">
            <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Server backups (/app/data/backups, newest 10 kept)
            </p>
            <ul className="space-y-0.5">
              {backups.slice(0, 5).map((backup) => (
                <li key={backup.file} className="flex items-center justify-between gap-2">
                  <a
                    href={`/api/dashboards/backup/${backup.file}`}
                    className="min-w-0 truncate underline underline-offset-2"
                  >
                    {backup.file}
                  </a>
                  <span className="shrink-0 text-muted-foreground">
                    {formatBytes(backup.bytes, 0)} · {formatDateTimeIso(backup.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-[11px] leading-snug text-muted-foreground">
          Exports contain layout and preference data only — the schema cannot hold secrets.
          Import validates and strips unknown fields; invalid or oversized files are rejected.
          Local (browser) views are never uploaded automatically.
        </p>
      </CardContent>
    </Card>
  );
}

/** Kept for potential external reuse (e.g. backup tooling UI). */
export { buildExportPayload };
