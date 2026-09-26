import { NextResponse, type NextRequest } from "next/server";
import { guardRead } from "@/server/auth/guard";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getEnvSafe } from "@/server/env";

export const dynamic = "force-dynamic";

const FILE_RE = /^dashboards-[0-9T-]+\.json$/;

/**
 * Downloads one server-side backup file. The filename must match the
 * generated pattern exactly (no traversal surface); content is the
 * sanitized schema shape only.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ file: string }> },
) {
  const guard = guardRead(request);
  if (!guard.ok) return guard.response;
  const { file } = await params;
  if (!FILE_RE.test(file)) {
    return NextResponse.json(
      { error: "Invalid backup filename." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const target = path.join(getEnvSafe().DASHBOARDS_DIR, "backups", file);
  if (!target.startsWith(path.join(getEnvSafe().DASHBOARDS_DIR, "backups")) || target.includes("..")) {
    return NextResponse.json(
      { error: "Invalid backup path." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const content = await readFile(target, "utf8");
    return new NextResponse(content, {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="${file}"`,
        "cache-control": "no-store",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Backup not found." },
      { status: 404, headers: { "cache-control": "no-store" } },
    );
  }
}
