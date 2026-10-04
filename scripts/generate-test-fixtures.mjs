// Regenerates tests/fixtures/helper-broken/ from the CURRENT helper entrypoint,
// minus the inventory require — the exact v1.3.13 incident, kept in lockstep.
import fs from "node:fs";

let s = fs.readFileSync("helper/server.js", "utf8");
if (!s.includes('require("./inventory")')) {
  throw new Error("server.js no longer requires ./inventory — the fixture premise is broken");
}
s = s.replace('const inventoryLib = require("./inventory");', "// fixture: require removed (models the v1.3.13 incident)");
fs.mkdirSync("tests/fixtures/helper-broken", { recursive: true });
fs.writeFileSync("tests/fixtures/helper-broken/server.js", s);
for (const f of ["inventory.js", "recreate.js", "compose.js"]) {
  fs.copyFileSync(`helper/${f}`, `tests/fixtures/helper-broken/${f}`);
}
console.log("fixtures regenerated");
