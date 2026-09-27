import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";

/** v0.7.10 quality release: contract- en regressietests. */

describe("v0.7.10 UTF-8 regressie (em-dash in 401-tekst)", () => {
  it("middleware-bron bevat de em-dash als correcte UTF-8-bytevolgorde", async () => {
    const bytes = await readFile("src/middleware.ts");
    const text = bytes.toString("utf8");
    // 401-tekst bevat een em-dash en geen losse mojibake-bytes (Ã¢â¬â)
    assert.match(text, /Unauthorized — /);
    assert.ok(!text.includes("Ã¢â¬â"), "mojibake gevonden");
    // E2 80 94 = em-dash in UTF-8
    const idx = text.indexOf("Unauthorized");
    const slice = bytes.subarray(idx, idx + 40);
    assert.ok(slice.includes(0xe2) && slice.includes(0x80) && slice.includes(0x94), "em-dash bytes");
  });

  it("charset=utf-8 op de plain-text 401-responses", async () => {
    const text = await readFile("src/middleware.ts", "utf8");
    assert.ok(text.includes("text/plain; charset=utf-8"));
  });
});

describe("v0.7.10 storage-contract regressie (v0.7.9-bug)", () => {
  it("DiskIoSnapshot-pagina leest data.data, niet de wrapper-top", async () => {
    // De storage-pagina moet de { meta, data }-wrapper uitpakken vóórdat ze
    // totals/devices leest. Bewijs op bronniveau:
    const src = await readFile("src/app/storage/page.tsx", "utf8");
    assert.match(src, /diskIoData\s*=\s*diskIo\.data\?\.data\s*\?\? null/);
    assert.match(src, /diskIoData\?\.totals\.readBytesPerSec/);
    // Oude foute patronen mogen niet terugkomen:
    assert.doesNotMatch(src, /diskIo\.data\.totals/);
    assert.doesNotMatch(src, /diskIo\.data\?\.devices/);
  });

  it("pagina-type is de wrapper, niet de kale snapshot", async () => {
    const src = await readFile("src/app/storage/page.tsx", "utf8");
    assert.match(src, /meta: MetricMeta; data: DiskIoSnapshot \| null/);
  });
});

describe("v0.7.10 update-dialog regressie (v0.7.9-bug)", () => {
  it("updates-paneel rendert de ConfirmDialog voor updates én rollbacks", async () => {
    const src = await readFile("src/components/docker/updates-panel.tsx", "utf8");
    assert.match(src, /\{updateTarget && \(/, "update-dialog ontbreekt");
    assert.match(src, /\{rollbackTarget && \(/, "rollback-dialog ontbreekt");
    assert.match(src, /confirmLabel="Start update"/);
    assert.match(src, /onClick=\{\(\) => setUpdateTarget\(container\)\}/);
  });

  it("actionError wordt gerenderd (geen stille falen)", async () => {
    const src = await readFile("src/components/docker/updates-panel.tsx", "utf8");
    assert.match(src, /\{actionError && \(/);
  });
});

describe("v0.7.10 update-status contract (route vs consumer)", () => {
  it("route bevat de velden die UpdatesSection leest", async () => {
    const route = await readFile("src/app/api/update/status/route.ts", "utf8");
    for (const field of ["rollbackCandidates", "history", "updateInProgress"]) {
      assert.ok(route.includes(field), `route mist ${field}`);
    }
    const dockerUpdates = await readFile("src/app/api/docker/updates/route.ts", "utf8");
    for (const field of ["checking", "pending"]) {
      assert.ok(dockerUpdates.includes(field), `docker/updates route mist ${field}`);
    }
    // Rollback/history velden in de settings-sectie; checking/pending in
    // het Docker-updates-paneel (aparte consumer, aparte test hierboven).
    const panel = await readFile("src/components/settings/updates-section.tsx", "utf8");
    for (const field of ["rollbackCandidates", "history"]) {
      assert.ok(panel.includes(field), `consumer mist ${field}`);
    }
  });

  it("settings About leest /api/update/status (niet de oude update-check)", async () => {
    const src = await readFile("src/app/settings/page.tsx", "utf8");
    assert.match(src, /usePoll<UpdateStatusPayload>\("\/api\/update\/status"/);
    assert.doesNotMatch(src, /"\/api\/update-check"/);
  });
});

describe("v0.7.10 helper-recreate parity (deelfasetests)", () => {
  it("recreate engine dekt env-via-envfile af (geen -e in argv)", async () => {
    const src = await readFile("helper/recreate.js", "utf8");
    // bewust: env nooit via argv
    assert.doesNotMatch(src, /push\("-e",/);
    assert.match(src, /Env is bewust NIET in de argv/);
  });

  it("run -d zit in de argv (v0.7.8-bug: docker --name zonder run)", async () => {
    const src = await readFile("helper/recreate.js", "utf8");
    assert.match(src, /const args = \["run", "-d"\];/);
  });

  it("rollback leest de pre-update snapshot (geen her-snapshot)", async () => {
    const src = await readFile("helper/server.js", "utf8");
    assert.match(src, /if \(rollback\) \{[\s\S]*?snapshot = JSON\.parse\(readFileSync\(snapshotFile/);
    // rollback- pad overschrijft de snapshot niet vóór gebruik
  });
});
