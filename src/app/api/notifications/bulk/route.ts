import { NextResponse, type NextRequest } from "next/server";
import { guardWrite } from "@/server/auth/guard";
import { checkWriteRate } from "@/server/dashboards/rate-limit";
import { recordAudit } from "@/server/actions/audit";
import { getUnraidClient } from "@/server/unraid/client";

export const dynamic = "force-dynamic";

/**
 * Notification bulk actions (v0.9.2):
 *   mark-all-read → archive every UNREAD notification (Unraid semantics:
 *                   "read" == archived; no separate read flag exists)
 *   archive-all   → explicit confirmation variant of the same mutation
 *
 * Both use the notification-archive GraphQL mutation with an explicit id
 * list (never an implicit empty-ids = all catch-all). Audited, no full-page
 * reload — the caller refreshes its own view.
 */

const LIST_UNREAD = /* GraphQL */ `
  query NotificationIdsUnread {
    notifications {
      list(filter: { type: UNREAD, offset: 0, limit: 200 }) {
        id
      }
    }
  }
`;

const ARCHIVE_IDS = /* GraphQL */ `
  mutation ArchiveNotifications($ids: [PrefixedID!]!) {
    archiveNotifications(ids: $ids) {
      archive {
        total
      }
      unread {
        total
      }
    }
  }
`;

export async function POST(request: NextRequest) {
  const guard = guardWrite(request);
  if (!guard.ok) return guard.response;
  const actor = guard.identity.user ?? "trusted-local";
  const rate = checkWriteRate(`notifications-bulk:${actor}@${guard.sourceIp}`);
  if (!rate.allowed) {
    return NextResponse.json(
      { error: "Too many notification actions — slow down." },
      { status: 429, headers: { "cache-control": "no-store" } },
    );
  }

  let body: { mode?: unknown; ids?: unknown; confirm?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const mode = typeof body.mode === "string" ? body.mode : "";

  // Explicit modes only. "selected" requires non-empty ids; an empty
  // selected list is a validation ERROR, never reinterpreted as "all".
  const MAX_IDS = 200;
  if (mode === "unread") {
    // archive every UNREAD notification (Unraid's "indicate all as read")
  } else if (mode === "all") {
    // archive every active notification — requires explicit confirmation
    if (body.confirm !== "yes") {
      return NextResponse.json(
        { error: "Mode all requires explicit confirmation." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
  } else if (mode === "selected") {
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return NextResponse.json(
        { error: "Mode selected requires a non-empty ids array." },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    if (body.ids.length > MAX_IDS) {
      return NextResponse.json(
        { error: `Mode selected is capped at ${MAX_IDS} ids per call.` },
        { status: 400, headers: { "cache-control": "no-store" } },
      );
    }
    if (!body.ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 200)) {
      return NextResponse.json({ error: "Invalid ids." }, { status: 400, headers: { "cache-control": "no-store" } });
    }
  } else {
    return NextResponse.json(
      { error: "Unknown mode. Allowed: unread, all, selected." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const client = getUnraidClient();
  try {
    let ids: string[] = [];
    if (mode === "unread" || mode === "all") {
      // Resolve the id list server-side from the live unread feed; even in
      // "all" mode the mutation receives an EXPLICIT id list (bounded 200)
      // so the empty-ids catch-all of the upstream API is never reachable.
      const listPayload = await client.request(LIST_UNREAD);
      const payloadShape = listPayload as { notifications?: { list?: Array<{ id: string }> } };
      ids = Array.isArray(payloadShape.notifications?.list)
        ? payloadShape.notifications.list.map((entry) => entry.id)
        : [];
      if (mode === "unread") {
        // "unread" mode = exactly the unread set (already resolved).
      }
    } else {
      ids = (body.ids as string[]).slice(0, MAX_IDS);
    }

    if (ids.length === 0) {
      await recordAudit({
        actor,
        sourceIp: guard.sourceIp,
        kind: "notification",
        action: "notifications-bulk",
        targetName: mode,
        targetId: "0 targets",
        result: "success",
        durationMs: 0,
      }).catch(() => {});
      return NextResponse.json({ ok: true, mode, archived: 0 }, { headers: { "cache-control": "no-store" } });
    }

    const payload = (await client.request(ARCHIVE_IDS, { ids })) as {
      archiveNotifications: { archive: { total: number }; unread: { total: number } };
    };
    await recordAudit({
      actor,
      sourceIp: guard.sourceIp,
      kind: "notification",
      action: "notifications-bulk",
      targetName: mode,
      targetId: `${ids.length} archived`,
      result: "success",
      durationMs: 0,
    }).catch(() => {});
    return NextResponse.json(
      { ok: true, mode, archived: ids.length, archiveTotal: payload.archiveNotifications.archive.total, unreadRemaining: payload.archiveNotifications.unread.total },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unraid API error";
    await recordAudit({
      actor,
      sourceIp: guard.sourceIp,
      kind: "notification",
      action: "notifications-bulk",
      targetName: mode,
      targetId: mode,
      result: "failed",
      durationMs: 0,
      error: message,
    }).catch(() => {});
    return NextResponse.json({ error: message.slice(0, 200) }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
