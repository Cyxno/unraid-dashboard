import type { NextRequest } from "next/server";
import { guardAgentRequest, agentCounters, setAgentSseClients, AGENT_API_VERSION } from "@/server/agent/auth";
import { subscribe } from "@/server/events/sampler";
import { getOverview } from "@/server/unraid/service";
import { getBuildInfo } from "@/server/version";

export const dynamic = "force-dynamic";

/**
 * Agent API SSE stream (v0.9.4): typed machine events.
 * - hello: apiVersion/beacon version/timestamp/identity/health summary
 * - docker.transition: container state changes (from the shared sampler)
 * - Bounded Last-Event-ID replay from an in-memory ring buffer (200 events).
 * No inventory dump on connect. Read-only.
 */

const RING_SIZE = 200;

const ringStore = globalThis as unknown as {
  __agentEventRing?: Array<{ id: number; event: string; data: unknown }>;
  __agentEventSeq?: number;
  __agentRingSubscriber?: (() => void) | null;
};

function ring(): Array<{ id: number; event: string; data: unknown }> {
  if (!ringStore.__agentEventRing) ringStore.__agentEventRing = [];
  return ringStore.__agentEventRing;
}

function nextEventId(): number {
  ringStore.__agentEventSeq = (ringStore.__agentEventSeq ?? 0) + 1;
  return ringStore.__agentEventSeq;
}

export async function GET(request: NextRequest) {
  const auth = guardAgentRequest(request, "stream");
  if (!auth.ok) {
    return new Response(JSON.stringify(auth.error), {
      status: auth.httpStatus ?? 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }

  const encoder = new TextEncoder();
  const lastEventIdHeader = request.headers.get("last-event-id");
  const url = new URL(request.url);
  const lastEventId = lastEventIdHeader ?? url.searchParams.get("lastEventId");
  const lastId = lastEventId ? Number(lastEventId) : null;

  const counters = agentCounters();
  counters.sseClients += 1;

  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown, eventId?: number) => {
        try {
          const idPart = eventId !== undefined ? `id: ${eventId}\n` : "";
          controller.enqueue(encoder.encode(`${idPart}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // stream closed
        }
      };

      // Hello/snapshot: identity + health only — no inventory dump.
      void (async () => {
        const overview = await getOverview("15m").catch(() => null);
        send("hello", {
          apiVersion: AGENT_API_VERSION,
          beaconVersion: getBuildInfo().version,
          timestamp: new Date().toISOString(),
          identity: { serverName: overview?.identity.data?.serverName ?? null, osVersion: overview?.identity.data?.osVersion ?? null },
          health: { level: overview?.health.level ?? null, reasons: overview?.health.reasons ?? [] },
        });

        // Replay ring events after Last-Event-ID.
        if (lastId !== null && Number.isFinite(lastId)) {
          for (const entry of ring()) {
            if (entry.id > lastId) send(entry.event, entry.data, entry.id);
          }
        }

        // Subscribe to shared sampler events, mapped to typed agent events.
        unsubscribe = subscribe((sampled) => {
          if (sampled.event === "state-transition") {
            const data = sampled.data as { name?: string; from?: string; to?: string; at?: string };
            const id = nextEventId();
            const payload = {
              eventId: id,
              timestamp: data.at ?? new Date().toISOString(),
              name: data.name ?? null,
              from: data.from ?? null,
              to: data.to ?? null,
            };
            ring().push({ id, event: "docker.transition", data: payload });
            if (ring().length > RING_SIZE) ring().splice(0, ring().length - RING_SIZE);
            send("docker.transition", payload, id);
          }
          // system.health is pushed by the sampler as its own event already
          // for the UI; forward a compact mapping for machines.
          if (sampled.event === "health") {
            const data = sampled.data as { level?: string | null; reasons?: string[] };
            const id = nextEventId();
            const payload = { eventId: id, timestamp: new Date().toISOString(), level: data.level ?? null, reasons: data.reasons ?? [] };
            ring().push({ id, event: "system.health", data: payload });
            if (ring().length > RING_SIZE) ring().splice(0, ring().length - RING_SIZE);
            send("system.health", payload, id);
          }
        });
      })();

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          // closed
        }
      }, 20_000);

      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        counters.sseClients -= 1;
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    },
  });
}
