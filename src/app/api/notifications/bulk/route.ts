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

  let body: { action?: unknown; confirm?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Malformed JSON body." }, { status: 400, headers: { "cache-control": "no-store" } });
  }
  const action = typeof body.action === "string" ? body.action : "";
  if (action !== "mark-all-read" && action !== "archive-all") {
    return NextResponse.json(
      { error: "Unknown action. Allowed: mark-all-read, archive-all." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  // Archive-all is the explicit-confirmation action.
  if (action === "archive-all" && body.confirm !== "yes") {
    return NextResponse.json(
      { error: "Archive all requires explicit confirmation." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }

  const client = getUnraidClient();
  try {
    // Collect unread ids (bounded at 200 like the list view).
    const listPayload = await client.request(LIST_UNREAD);
    const payloadShape = listPayload as { notifications?: { list?: Array<{ id: string }> } };
    const list: Array<{ id: string }> = Array.isArray(payloadShape.notifications?.list)
      ? payloadShape.notifications.list
      : [];
    const ids = list.map((entry) => entry.id);
    if (ids.length === 0) {
      await recordAudit({
        actor,
        sourceIp: guard.sourceIp,
        kind: "notification",
        action: "notifications-bulk",
        targetName: action,
        targetId: "0 unread",
        result: "success",
        durationMs: 0,
      }).catch(() => {});
      return NextResponse.json({ ok: true, archived: 0, unreadRemaining: 0 }, { headers: { "cache-control": "no-store" } });
    }

    const payload = (await client.request(ARCHIVE_IDS, { ids })) as {
      archiveNotifications: { archive: { total: number }; unread: { total: number } };
    };
    const archived = payload.archiveNotifications.archive.total;
    const unreadRemaining = payload.archiveNotifications.unread.total;
    await recordAudit({
      actor,
      sourceIp: guard.sourceIp,
      kind: "notification",
      action: "notifications-bulk",
      targetName: action,
      targetId: `${ids.length} archived`,
      result: "success",
      durationMs: 0,
    }).catch(() => {});
    return NextResponse.json(
      { ok: true, archived: ids.length, archiveTotal: archived, unreadRemaining },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unraid API error";
    await recordAudit({
      actor,
      sourceIp: guard.sourceIp,
      kind: "notification",
      action: "notifications-bulk",
      targetName: action,
      targetId: action,
      result: "failed",
      durationMs: 0,
      error: message,
    }).catch(() => {});
    return NextResponse.json({ error: message.slice(0, 200) }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
