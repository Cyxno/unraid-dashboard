import type { NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { recentTransitions, subscribe } from "@/server/events/sampler";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream for lightweight realtime state.
 * Same auth policy as every other API route (guardRead), same-origin
 * only, no credentials or secrets in the payload. One shared server
 * sampler fans out to all subscribers — browsers never drive polling.
 */
export async function GET(request: NextRequest) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
          );
        } catch {
          // stream already closed
        }
      };

      // Initial catch-up: recent observed transitions + hello.
      send("hello", { transitions: recentTransitions().slice(0, 10) });

      unsubscribe = subscribe((event) => send(event.event, event.data));

      // Comment heartbeat keeps proxies from idling the connection out.
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          // closed
        }
      }, 20_000);

      request.signal.addEventListener("abort", () => {
        unsubscribe?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
      });
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
