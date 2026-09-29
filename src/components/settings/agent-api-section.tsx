"use client";

import { Bot } from "lucide-react";
import { usePoll } from "@/hooks/use-poll";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Settings → Agent API (v0.9.4): small status card for the read-only
 * machine API. Shows enablement (credential configured), API version and
 * a documentation pointer. Never shows the token.
 */

import type { DiagnosticsPayload } from "@/lib/api-types";

export function AgentApiSection() {
  const diagnostics = usePoll<DiagnosticsPayload>("/api/diagnostics", 30_000);
  const agentApi = diagnostics.data?.self.agentApi;
  const enabled = agentApi?.enabled ?? false;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <Bot className="size-4 text-muted-foreground" aria-hidden />
          Agent API
          <Badge variant={enabled ? "success" : "muted"}>{enabled ? "enabled" : "disabled"}</Badge>
          <Badge variant="outline" className="text-[10px]">
            read-only · v1
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0 text-xs text-muted-foreground">
        <p>
          {enabled
            ? "Read-only machine API active — bearer credential required. See docs/AGENT_API.md."
            : "Disabled — set AGENT_API_TOKEN (min 32 chars) to enable the read-only machine API."}
        </p>
        {agentApi && (
          <p className="mt-1">
            requests: {agentApi.requests} · auth failures: {agentApi.authFailures} · rate-limit hits:{" "}
            {agentApi.rateLimitHits} · SSE clients: {agentApi.sseClients}
            {agentApi.lastRequestAt ? ` · last: ${agentApi.lastRequestEndpoint}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
