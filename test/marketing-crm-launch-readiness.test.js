import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("Meta CAPI defaults to the active NextGen website dataset", () => {
  assert.match(server, /process\.env\.META_PIXEL_ID \|\| "1388825176707854"/);
  assert.match(server, /app\.post\("\/api\/capi-event"/);
});

test("large-database background work uses production-safe intervals", () => {
  assert.match(server, /ASSESSMENT_AUTO_RELEASE_INTERVAL_MS \|\| 60 \* 1000/);
  assert.match(server, /AYLA_PRIVATE_PILOT_RECONCILIATION_INTERVAL_MS \|\| 6 \* 60 \* 60 \* 1000/);
  assert.doesNotMatch(server, /AYLA_PRIVATE_PILOT_RECONCILIATION_INTERVAL_MS \|\| 10 \* 60 \* 1000/);
});
