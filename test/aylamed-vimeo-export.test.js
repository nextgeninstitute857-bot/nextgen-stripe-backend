import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("Vimeo export uses a short-lived authenticated link and a real attachment response", () => {
  const start = server.indexOf('app.get("/api/ayla/admin/resources/vimeo-catalog/export-link"');
  const end = server.indexOf('app.post("/api/ayla/admin/resources/vimeo-catalog/classification-jobs"', start);
  assert.ok(start >= 0 && end > start, "Vimeo export routes must be present");
  const routes = server.slice(start, end);

  assert.match(routes, /await aylaRequireAdmin\(req\)/);
  assert.match(routes, /expiresIn: "5m"/);
  assert.match(routes, /jwt\.verify/);
  assert.match(routes, /Content-Disposition/);
  assert.match(routes, /attachment; filename=/);
  assert.match(routes, /aylaVimeoCatalogDrafts/);
  assert.match(routes, /video_only: true/);
  assert.match(routes, /read_only: true/);
  assert.doesNotMatch(routes, /aylaNoCreditMcqExportPage|provider_pairs|ngContentBackgroundQueue|createVimeoClassificationJob/);
});

test("Vimeo export payload remains private and performs no writes", () => {
  assert.match(server, /vimeo_results_private_until_manual_approval: true/);
  assert.match(server, /writes_performed: 0/);
  assert.match(server, /classifier_jobs_started: 0/);
});
