import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const registry = fs.readFileSync(
  new URL("../lib/content-registry-postgres.js", import.meta.url),
  "utf8",
);
const r2RepairStart = server.indexOf(
  'app.post("/admin/crm/ai-training/content-media-imports/:mediaJobId/reconcile-draft-links"',
);
const r2RepairEnd = server.indexOf(
  "async function ngRunContentVideoDraftImport",
  r2RepairStart,
);
const r2Repair = server.slice(r2RepairStart, r2RepairEnd);

test("contextual media repair is audit-first and fingerprint guarded", () => {
  assert.match(
    server,
    /app\.get\("\/admin\/crm\/ai-training\/content-media-imports\/:mediaJobId\/mapping-audit"/,
  );
  assert.match(
    server,
    /app\.post\("\/admin\/crm\/ai-training\/content-media-imports\/:mediaJobId\/reconcile-draft-links"/,
  );
  assert.match(server, /expectedFingerprint !== audit\.fingerprint/);
  assert.match(server, /Wait for the media import to finish before auditing its draft links/);
  assert.match(server, /ngAuditContentMediaObjectStorage\(report\.matches\)/);
  assert.match(server, /binary_storage_verified: storageAudit\.verified/);
  assert.match(server, /no_binary_reupload_required: storageAudit\.verified/);
  assert.match(server, /if \(!audit\.storageAudit\?\.verified\)/);
});

test("R2 reconciliation inserts only missing draft links without publishing or overwriting", () => {
  assert.match(server, /audit\.linkAudit\.missingMatches\.slice/);
  assert.match(server, /existing_links_overwritten: 0/);
  assert.match(server, /student_resources_published: 0/);
  assert.match(server, /binary_files_reuploaded: 0/);
  assert.match(r2Repair, /binary_objects_deleted: 0/);
  assert.match(r2Repair, /duplicate_objects_preserved/);
  assert.doesNotMatch(r2Repair, /deleteR2Object/);
  assert.match(registry, /export async function auditContentMediaLinks/);
  assert.match(registry, /LEFT JOIN content_question_media qm/);
});

test("R2 repair pools completed sibling packages and uses canonical plus alias editions", () => {
  assert.match(server, /listContentMediaImportAssetsForParent\(parentJob\.id\)/);
  assert.match(server, /cross_package_asset_pool: true/);
  assert.match(server, /source_media_job_ids: sourceMediaJobIds/);
  assert.match(
    registry,
    /export async function listContentMediaImportAssetsForParent\(contentImportJobId\)/,
  );
  assert.match(registry, /jobs\.status LIKE 'draft_imported%'/);
  assert.match(registry, /AS source_snapshot_aliases/);
  assert.match(registry, /sourceSnapshot: sourceFile/);
  assert.match(registry, /sourceSnapshotAliases:/);
});

test("Vimeo reconciliation reuses the saved package and deduplicates repeated starts", () => {
  assert.match(
    server,
    /app\.get\("\/admin\/crm\/ai-training\/content-video-imports\/:videoJobId\/reconcile-audit"/,
  );
  assert.match(
    server,
    /app\.post\("\/admin\/crm\/ai-training\/content-video-imports\/:videoJobId\/reconcile-draft-links"/,
  );
  assert.match(server, /repair_of_video_job_id/);
  assert.match(server, /sha256_vimeo_deduplication: true/);
  assert.match(server, /source_zip_uploaded_again: false/);
  assert.match(server, /existingRepair/);
});

test("current basename-only imports recover contextual paths from stored HTML and source file", () => {
  assert.match(registry, /q\.question_html/);
  assert.match(registry, /q\.explanation_html/);
  assert.match(registry, /media_match_paths/);
  assert.match(registry, /mediaReferencePathCandidates\(reference, \{ sourceFile \}\)/);
  assert.match(registry, /matchPaths: \[\.\.\.new Set\(matchPaths\)\]/);
});
