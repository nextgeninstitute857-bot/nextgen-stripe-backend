import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

test("owned catalogue supports exact-student delivery without global publication", () => {
  assert.match(server, /AYLA_STUDENT_CATALOG_SCOPE_PREFIX = "student:"/);
  assert.match(server, /function aylaStudentCatalogDestinationScope/);
  assert.match(server, /owned-collections\/:collectionId\/student-access/);
  assert.match(server, /dx-\[0-9\]\{6\}-\[0-9a-f\]\{8\}/i);
  assert.match(server, /source_profile \|\| ""\) !== "aylamed_original"/);
  assert.match(server, /destination_scope: "", enabled: false/);
  assert.match(server, /destination_scope: destinationScope, enabled: true/);
  assert.match(server, /sourceRightsStatus: "owned"/);
  assert.match(server, /global_student_access: false/);
  assert.match(server, /legacy_catalogue_changed: false/);
});

test("ordinary full-access students resolve to a stable private catalogue scope", () => {
  assert.match(server, /return pilotScope/);
  assert.match(server, /`\$\{AYLA_STUDENT_CATALOG_SCOPE_PREFIX\}\$\{studentId\}`/);
  assert.ok((server.match(/aylaStudentCatalogDestinationScope\((?:auth\.)?student\)/g) || []).length >= 3);
});

test("owned catalogue importer accepts the existing AylaMed admin session", () => {
  assert.match(server, /async function requireOwnedCatalogAdmin\(req\)/);
  assert.match(server, /const aylaAdmin = await aylaRequireAdmin\(req\)/);
  assert.match(server, /aylamed-owned-catalog-admin/);
  assert.ok((server.match(/requireOwnedCatalogAdmin\(req\)/g) || []).length >= 5);
  assert.match(server, /content-imports\/preview[\s\S]{0,300}requireOwnedCatalogAdmin\(req\)/);
  assert.match(server, /content-imports\/:jobId[\s\S]{0,220}requireOwnedCatalogAdmin\(req\)/);
  assert.match(server, /content-registry\/collections[\s\S]{0,220}requireOwnedCatalogAdmin\(req\)/);
});
