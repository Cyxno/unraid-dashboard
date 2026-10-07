import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { classifyTestPush } from "../src/server/notifications/push";

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));

/* ---- Fase 18: live-trace surface in Settings ----------------------------- */

describe("v1.3.24 registration trace surface", () => {
  test("settings section captures and renders the registration trace", () => {
    const section = fs.readFileSync(
      path.join(ROOT, "src", "components", "settings", "notifications-section.tsx"),
      "utf8",
    );
    assert.match(section, /PushTraceEntry\[\] \| null/);
    assert.match(section, /Registration trace \(last attempt\)/);
    assert.match(section, /\(entry\) => trace\.push\(entry\)/);
  });
});
