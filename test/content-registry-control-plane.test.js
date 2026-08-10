import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const postgres = fs.readFileSync(new URL('../lib/content-registry-postgres.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');

test('exact question identity remains isolated by exam track', () => {
  assert.match(postgres, /UNIQUE\(exam_track, canonical_hash\)/);
  assert.match(postgres, /WHERE exam_track=\$1 AND canonical_hash=ANY/);
});

test('collection destinations are persistent controls rather than upload-only intent', () => {
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS content_collection_destinations/);
  assert.match(postgres, /UNIQUE\(collection_id, destination, destination_scope\)/);
  assert.match(server, /content-registry\/collections\/:collectionId\/controls/);
});

test('unverified content may be prepared privately but cannot be approved or enabled for students', () => {
  const draftRoute = server.slice(
    server.indexOf('app.post("/admin/crm/ai-training/content-imports/:jobId/import-draft"'),
    server.indexOf('app.get("/admin/crm/ai-training/content-imports/:jobId"'),
  );
  const mediaRoute = server.slice(
    server.indexOf('app.post("/admin/crm/ai-training/content-imports/:jobId/media/import-draft"'),
    server.indexOf('app.get("/admin/crm/ai-training/content-media-imports/:mediaJobId"'),
  );
  const videoRoute = server.slice(
    server.indexOf('app.post("/admin/crm/ai-training/content-imports/:jobId/videos/import-draft"'),
    server.indexOf('app.get("/admin/crm/ai-training/content-video-imports/:videoJobId"'),
  );
  for (const route of [draftRoute, mediaRoute, videoRoute]) {
    assert.doesNotMatch(route, /CONTENT_RIGHTS_VERIFICATION_REQUIRED/);
  }
  assert.match(postgres, /requiresVerifiedRights = cleanStatus === 'approved'/);
  assert.match(postgres, /controls\?\.some\(\(row\) => row\.enabled\)/);
  assert.match(postgres, /CONTENT_RIGHTS_VERIFICATION_REQUIRED/);
  assert.match(postgres, /CONTENT_RIGHTS_DOWNGRADE_REQUIRES_DISABLE/);
  assert.match(
    postgres,
    /WHEN content_collections\.source_rights_status IN \('owned','licensed','authorized'\)[\s\S]*?THEN content_collections\.source_rights_status/,
  );
});

test('one mixed media ZIP is uploaded once and processed through private R2 and Vimeo stages', () => {
  assert.match(server, /content-imports\/:jobId\/media-bundle\/import-draft/);
  assert.match(server, /content-media-bundle-imports\/:backgroundJobId/);
  assert.match(server, /type: "content_media_bundle_draft"/);
  assert.match(server, /lane: "media_bundle_zip"/);
  assert.match(server, /single_upload: true/);
  assert.match(server, /ngContentBackgroundQueue\.register\("content_media_bundle_draft"/);
  assert.match(server, /ngRunContentMediaDraftImport\([\s\S]*?ngRunContentVideoDraftImport/);
});

test('private media recovery follows the exact collection across re-import job IDs but never active student delivery', () => {
  const referenceQuery = postgres.slice(
    postgres.indexOf('export async function getContentMediaReferences'),
    postgres.indexOf('export async function createContentVideoImportJob'),
  );
  assert.match(referenceQuery, /WITH target_job AS/);
  assert.match(referenceQuery, /FROM content_import_jobs/);
  assert.match(referenceQuery, /WHERE id=\$1::uuid/);
  assert.match(referenceQuery, /a\.source_data->>'import_job_id'=\$2::text/);
  assert.match(referenceQuery, /\[contentImportJobId, String\(contentImportJobId \|\| ""\)\]/);
  assert.doesNotMatch(referenceQuery, /a\.source_data->>'import_job_id'=\$1(?:\s|$)/);
  assert.match(referenceQuery, /a\.exam_track=j\.exam_track/);
  assert.match(referenceQuery, /a\.source_namespace=j\.source_namespace/);
  assert.match(referenceQuery, /c\.source_provider=j\.source_provider/);
  assert.match(referenceQuery, /c\.source_profile=j\.source_profile/);
  assert.match(referenceQuery, /COALESCE\(j\.collection_title,''\)=COALESCE\(c\.title,''\)/);
  assert.match(referenceQuery, /CONCAT\(COALESCE\(j\.collection_title,''\), ': ', c\.collection_key\)/);
  assert.match(referenceQuery, /FROM scoped_aliases a/);
  assert.doesNotMatch(referenceQuery, /FROM scoped_aliases a[\s\S]{0,180}a\.source_data->>'import_job_id'=\$1/);
  assert.match(referenceQuery, /delivery_collection\.status='approved'/);
  assert.match(referenceQuery, /delivery_destination\.enabled=TRUE/);
  assert.match(referenceQuery, /delivery_alias\.question_id=q\.id/);
  assert.match(referenceQuery, /NOT IN \('archived','deleted','quarantined','rejected'\)/);
  assert.doesNotMatch(referenceQuery, /q\.status='draft'/);
});

test('an empty media-reference inventory fails with actionable recovery evidence', () => {
  const mediaImport = server.slice(
    server.indexOf('async function ngRunContentMediaDraftImport'),
    server.indexOf('app.post("/admin/crm/ai-training/content-imports/:jobId/media/import-draft"'),
  );
  assert.match(mediaImport, /CONTENT_MEDIA_REFERENCE_INVENTORY_EMPTY/);
  assert.match(mediaImport, /entries_scanned: entriesScanned/);
  assert.match(mediaImport, /question_media_references: referenceCount/);
  assert.match(mediaImport, /uploaded_zip_reusable: true/);
  assert.match(mediaImport, /no image\/audio filename matched/);
});

test('named collections recover their private draft import job after an admin page refresh', () => {
  assert.match(postgres, /recovered_job\.draft_import_job_id/);
  assert.match(postgres, /recovered_job\.draft_import_job_status/);
  assert.match(postgres, /j\.exam_track=c\.exam_track/);
  assert.match(postgres, /j\.source_namespace=c\.source_namespace/);
  assert.match(postgres, /j\.source_profile=c\.source_profile/);
  assert.match(postgres, /COALESCE\(j\.collection_title,''\)=COALESCE\(c\.title,''\)/);
  assert.match(postgres, /CONCAT\(COALESCE\(j\.collection_title,''\), ': ', c\.collection_key\)/);
  assert.match(postgres, /j\.status IN \('draft_imported','draft_imported_with_warnings'\)/);
});

test('AylaMed native approval and publication are separate fail-closed gates', () => {
  assert.match(postgres, /AYLAMED_NATIVE_APPROVAL_GATE_BLOCKED/);
  assert.match(postgres, /AYLAMED_NATIVE_APPROVAL_REQUIRED/);
  assert.match(postgres, /AYLAMED_NATIVE_PUBLICATION_GATE_BLOCKED/);
  assert.match(postgres, /taxonomy_complete_count/);
  assert.match(postgres, /native_answer_shape_ready_count/);
  assert.match(postgres, /native_publication_ready_count/);
  assert.match(postgres, /native_media_ready_count/);
  assert.match(postgres, /delivery_collection\.status='approved'/);
  assert.match(postgres, /delivery_destination\.enabled=TRUE/);
  assert.match(server, /content-registry\/collections\/:collectionId\/controls[\s\S]{0,160}requireOwnedCatalogAdmin\(req\)/);
  assert.match(postgres, /AYLAMED_OWNED_COLLECTION_REQUIRED/);
});

test('AylaMed Publish All is collection-scoped, count-locked, and QBank-only', () => {
  assert.match(server, /content-registry\/collections\/:collectionId\/publish-all/);
  assert.match(server, /content-registry\/collections\/:collectionId\/unpublish-all/);
  assert.match(server, /requiredConfirmation = `PUBLISH ALL \$\{expectedQuestionCount\}`/);
  assert.match(server, /requiredConfirmation = `UNPUBLISH ALL \$\{expectedQuestionCount\}`/);
  assert.match(server, /destination: 'aylamed_qbank'/);
  assert.match(server, /destination_scope: ''/);
  assert.match(server, /ownedOnly: true/);
  assert.match(server, /publishAll: true/);
  assert.match(postgres, /AYLAMED_PUBLISH_ALL_APPROVAL_REQUIRED/);
  assert.match(postgres, /AYLAMED_BULK_PUBLICATION_COUNT_CHANGED/);
  assert.match(postgres, /AYLAMED_BULK_PUBLICATION_OWNERSHIP_MISMATCH/);
  assert.match(postgres, /AYLAMED_PUBLISH_ALL_DESTINATION_REQUIRED/);
  assert.match(postgres, /AYLAMED_UNPUBLISH_ALL_DESTINATION_REQUIRED/);
  assert.match(server, /preserved: \['questions', 'answers', 'taxonomy', 'media references', 'source aliases', 'review history'\]/);
});

test('question ID display policy supports internal, source, both, and hidden modes', () => {
  for (const mode of ['internal', 'source', 'both', 'hidden']) assert.match(postgres, new RegExp(`'${mode}'`));
  for (const mode of ['provider', 'neutral', 'hidden']) assert.match(postgres, new RegExp(`'${mode}'`));
});

test('QBank presentation policy is persistent per exam and cannot alter roadmap or tutor source coverage', () => {
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS content_qbank_presentation_policies/);
  assert.match(postgres, /student_bank_mode TEXT NOT NULL DEFAULT 'unified_aylamed'/);
  assert.match(server, /content-registry\/qbank-presentation-policy/);
  assert.match(server, /Roadmap and Personal Tutor continue using all approved source profiles/);
  assert.match(server, /roadmapAssignmentId \|\| purpose === "baseline_diagnostic"\s*\?\s*""/);
});

test('source learning profiles remain separate from collection question-ID display policy', () => {
  for (const profile of [
    'uworld_style', 'amboss_style', 'canadaqbank_style', 'aceqbank_style',
    'amedex_style', 'mplusx_style', 'aylamed_original', 'other',
  ]) {
    assert.match(postgres, new RegExp(`"${profile}"`));
  }
  assert.match(postgres, /source_profile TEXT NOT NULL DEFAULT 'other'/);
  assert.match(postgres, /LOWER\(source_provider\) LIKE '%uworld%'.*?'uworld_style'/s);
  assert.match(postgres, /LOWER\(source_provider\) LIKE '%amboss%'.*?'amboss_style'/s);
  assert.match(postgres, /LOWER\(source_provider\) LIKE '%canadaqbank%'.*?'canadaqbank_style'/s);
  assert.match(postgres, /LOWER\(source_provider\) LIKE '%aceqbank%'.*?'aceqbank_style'/s);
  assert.match(postgres, /LOWER\(source_provider\) LIKE '%amedex%'.*?'amedex_style'/s);
  assert.match(postgres, /LOWER\(source_provider\) LIKE '%mplusx%'.*?'mplusx_style'/s);
  assert.match(postgres, /display_policy JSONB NOT NULL DEFAULT/);
  assert.match(server, /sourceProfile: req\.body\.source_profile \?\? req\.body\.sourceProfile/);
});

test('reviewed QBank media aliases persist with the preview job and remain path-only metadata', () => {
  assert.match(postgres, /media_aliases JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(postgres, /media_aliases_fingerprint TEXT NOT NULL DEFAULT ''/);
  assert.match(postgres, /JSON\.stringify\(job\.mediaAliases \|\| \[\]\)/);
  assert.match(server, /normalizeBulkQbankMediaAliases/);
  assert.match(server, /media_quarantine_samples: preview\.mediaQuarantine/);
  assert.match(server, /mediaAliasesFingerprint/);
});

test('disabling one collection cannot unapprove a question shared by another approved collection', () => {
  assert.match(postgres, /approved_collection\.status='approved'/);
  assert.match(postgres, /THEN 'approved' ELSE 'draft'/);
});

test('taxonomy mappings are exam and provider namespace scoped and reused on future imports', () => {
  assert.match(postgres, /UNIQUE\(exam_track, source_namespace, source_system_id, source_subject_id\)/);
  assert.match(postgres, /m\.source_system_id=q\.system_key AND m\.source_subject_id=q\.subject_key/);
  assert.match(server, /content-registry\/taxonomy-mappings/);
});

test('specialized CDM cases cannot be claimed by the ordinary MCQ draft importer', () => {
  assert.match(server, /counts\?\.import_blocked === true/);
  assert.match(server, /blocking specialized-format or exam-mapping issue/);
  assert.match(postgres, /counts->>'import_blocked'/);
  assert.match(postgres, /counts->>'blocking_issues'/);
});

test('student catalog requires ownership, exam entitlement, and approved enabled QBank content', () => {
  assert.match(server, /aylaV189RequireStudent\(req/);
  assert.match(server, /aylaRequireQbankAccess\(auth\.db, auth\.user, auth\.student/);
  assert.match(postgres, /q\.status='approved'/);
  assert.match(postgres, /c\.status='approved'/);
  assert.match(postgres, /d\.destination=\$2 AND d\.enabled=TRUE/);
});

test('credentialed CORS is limited to exact owned LMS origins and explicit environment additions', () => {
  for (const origin of [
    'https://live.nextgenusmlelms.com', 'https://www.live.nextgenusmlelms.com',
    'https://lms.nextgenusmlelms.com', 'https://www.lms.nextgenusmlelms.com',
    'https://mediumslateblue-otter-394719.hostingersite.com',
    'https://paleturquoise-quail-255896.hostingersite.com',
  ]) assert.match(server, new RegExp(origin.replaceAll('.', '\\.')));
  assert.match(server, /NEXTGEN_CORS_ALLOWED_ORIGINS/);
  assert.doesNotMatch(server, /usmlecorner\.com/);
  assert.doesNotMatch(server, /http:\/\/localhost:5173/);
  assert.doesNotMatch(server, /host\.endsWith\("\.nextgenusmlelms\.com"\)/);
  assert.doesNotMatch(server, /origin:\s*true/);
});
