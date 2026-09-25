"use client";

import { Monitor } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { PAGE_INTERVAL_MS } from "@/lib/prefs";
import { PageHeader, LoadingPanel, EmptyPanel } from "@/components/dashboard/page-primitives";
import { SectionStatus } from "@/components/dashboard/section-status";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { humanState } from "@/lib/utils";
import type { Section, VmsSummary } from "@/lib/api-types";

export default function VmsPage() {
  const { data, error, loading } = usePoll<Section<VmsSummary>>(
    "/api/vms",
    PAGE_INTERVAL_MS.vms,
  );
  const vms = data?.data ?? null;

  return (
    <div>
      <PageHeader
        title="VMs"
        description="Virtual machines (read-only)"
        actions={
          <SectionStatus
            section={
              data ?? { status: "unavailable", data: null, fetchedAt: "", ageMs: 0 }
            }
          />
        }
      />

      {loading && !data ? (
        <LoadingPanel rows={4} />
      ) : error && !data ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm"
        >
          VM data unavailable: {error}
        </p>
      ) : vms ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Monitor className="size-4 text-muted-foreground" aria-hidden="true" />
              Virtual machines
              <Badge variant="muted">
                {vms.running}/{vms.total} running
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {vms.vms.length === 0 ? (
              <EmptyPanel message="No virtual machines defined." />
            ) : (
              <ul className="divide-y">
                {vms.vms.map((vm) => (
                  <li key={vm.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                    <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {vm.name}
                    </span>
                    <Badge variant={vm.state === "RUNNING" ? "success" : "muted"}>
                      {humanState(vm.state)}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-4 text-[11px] text-muted-foreground">
              The Unraid GraphQL API version on this server (7.3.2) exposes only
              VM name and state — vCPU, memory and autostart details are not
              available to the dashboard. VM controls are intentionally not
              implemented.
            </p>
          </CardContent>
        </Card>
      ) : (
        <p className="text-sm text-muted-foreground">VM data unavailable.</p>
      )}
    </div>
  );
}
