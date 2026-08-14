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
  assert.match(server, /dx-\[0-9\]\{6\}-\[0-9a-f\]\{8\}/i);
  assert.match(server, /`\$\{AYLA_STUDENT_CATALOG_SCOPE_PREFIX\}\$\{studentId\}`/);
  assert.ok((server.match(/aylaStudentCatalogDestinationScope\((?:auth\.)?student\)/g) || []).length >= 3);
});

test("owned catalogue assignment resolves native AylaMed IDs case-insensitively", () => {
  assert.match(server, /aylaValues\(db, "aylaStudents"\)\.find/);
  assert.match(server, /row\.id \|\| row\.student_id \|\| row\.studentId/);
  assert.match(server, /\.trim\(\)\.toLowerCase\(\) === studentId/);
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

test("the same admin may stage only the explicitly authorized launch providers", () => {
  assert.match(server, /function ngAuthorizedExternalImportSource\(source = \{\}\)/);
  assert.match(server, /contentAuthorizedExternalReleaseAllowed\(source\)/);
  assert.match(server, /AYLAMED_AUTHORIZED_EXTERNAL_SCOPE_REQUIRED/);
  assert.match(server, /\["question_zip", "mixed_qbank_zip"\]/);
  assert.match(server, /requireAylaMedContentJobAdmin\(req, existing\)/);
  assert.match(server, /requireAylaMedContentJobAdmin\(req, parentJob\)/);
});

test("new staged media handoff is scoped by uploader, media purpose, and owned parent job", () => {
  assert.match(server, /function ngOwnedAylaMedImportJob\(job = \{\}\)/);
  assert.match(server, /job\?\.source_provider \|\| ""\)\.toLowerCase\(\) === "aylamed"/);
  assert.match(server, /job\?\.source_profile \|\| ""\)\.toLowerCase\(\) === "aylamed_original"/);
  assert.match(server, /job\?\.source_rights_status \|\| ""\)\.toLowerCase\(\) === "owned"/);
  assert.match(server, /String\(session\?\.created_by \|\| ""\) === expectedCreator/);
  assert.match(server, /\["media_zip", "mixed_qbank_zip"\][\s\S]{0,120}session\?\.purpose/);
  assert.match(server, /const parentAllowed = !parentJob[\s\S]{0,180}ngAuthorizedExternalImportSource\(parentJob\)/);
  assert.match(server, /if \(!ownsSession \|\| !isMediaArchive \|\| !parentAllowed\)/);
  assert.match(server, /if \(uploadId\) await requireOwnedMediaBundleAdmin\(req, uploadId, null, auth\)/);
  assert.match(server, /media-bundle\/import-draft[\s\S]{0,1500}requireOwnedMediaBundleAdmin\(req, uploadId, parentJob, auth\)/);
});

test("existing matching jobs recover through the owned collection even when the admin login method changes", () => {
  assert.match(server, /async function requireOwnedMediaBundleJobAdmin\(req, privateBundleJob, context = null\)/);
  assert.match(server, /requireOwnedMediaBundleJobAdmin[\s\S]{0,1200}ngOwnedAylaMedImportJob\(parentJob\)/);
  assert.match(server, /isFinalizedMediaArchive[\s\S]{0,200}"media_zip"[\s\S]{0,200}"finalized"/);
  assert.doesNotMatch(
    server.match(/async function requireOwnedMediaBundleJobAdmin[\s\S]*?return \{ auth, uploadId, parentJob \};/)?.[0] || "",
    /created_by|expectedCreator/,
  );
});

test("owned media polling authorizes with the private payload but returns a sanitized job", () => {
  assert.match(server, /async function ngOwnedMediaBundlePollSnapshot\(req, privateBundleJob, auth = null\)/);
  assert.match(server, /privateBundleJob\.payload\?\.upload_id/);
  assert.match(server, /const bundleJob = ngContentBackgroundQueue\.get\(privateBundleJob\.id\)/);
  assert.match(server, /content-media-bundle-imports\/:backgroundJobId[\s\S]{0,500}includePayload: true/);
  assert.match(server, /bundle_job: bundleJob/);
  assert.match(server, /content-imports\/:jobId\/media-bundle\/latest/);
  assert.match(server, /type: "content_media_bundle_draft"[\s\S]{0,120}includePayload: true/);
});

test("owned media retry requeues the failed job from the finalized R2 archive without duplicating it", () => {
  assert.match(server, /content-imports\/:jobId\/media-bundle\/retry/);
  assert.match(server, /resolveFinalized\(uploadId, \{ allowedPurposes: \["media_zip", "mixed_qbank_zip"\] \}\)/);
  assert.match(server, /ngContentUploadStore\.acquire\(uploadId, backgroundJobId\)/);
  assert.match(server, /ngContentBackgroundQueue\.retry\(backgroundJobId\)/);
  assert.match(server, /requeued: true/);
  assert.match(server, /deduplicated: true/);
  assert.match(server, /No upload or duplicate job was created/);
  assert.doesNotMatch(
    server.match(/app\.post\("\/admin\/crm\/ai-training\/content-imports\/:jobId\/media-bundle\/retry"[\s\S]*?\n\}\);/)?.[0] || "",
    /ngQueueContentOperation|createContentMediaImportJob|createContentVideoImportJob/,
  );
});
