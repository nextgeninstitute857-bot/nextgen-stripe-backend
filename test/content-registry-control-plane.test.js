import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const postgres = fs.readFileSync(new URL('../lib/content-registry-postgres.js', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const readPathIndexes = fs.readFileSync(
  new URL('../scripts/content-registry-read-path-indexes.sql', import.meta.url),
  'utf8',
);

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

test('private media recovery discovers protected questions without mutating active student delivery', () => {
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
  assert.match(referenceQuery, /c\.source_profile=j\.source_profile/);
  assert.doesNotMatch(referenceQuery, /c\.source_provider=j\.source_provider/);
  assert.match(referenceQuery, /COALESCE\(j\.collection_title,''\)=COALESCE\(c\.title,''\)/);
  assert.match(referenceQuery, /CONCAT\(COALESCE\(j\.collection_title,''\), ': ', c\.collection_key\)/);
  assert.match(referenceQuery, /FROM scoped_aliases a/);
  assert.doesNotMatch(referenceQuery, /FROM scoped_aliases a[\s\S]{0,180}a\.source_data->>'import_job_id'=\$1/);
  assert.match(referenceQuery, /delivery_collection\.status='approved'/);
  assert.match(referenceQuery, /delivery_destination\.enabled=TRUE/);
  assert.match(referenceQuery, /delivery_alias\.question_id=q\.id/);
  assert.match(referenceQuery, /AS student_delivery_protected/);
  assert.doesNotMatch(referenceQuery, /WHERE LOWER\(COALESCE\(q\.status,''\)\)[\s\S]{0,180}AND NOT EXISTS/);
  assert.match(referenceQuery, /NOT IN \('archived','deleted','quarantined','rejected'\)/);
  assert.doesNotMatch(referenceQuery, /q\.status='draft'/);
  assert.match(referenceQuery, /a\.source_data AS alias_source_data/);
  assert.match(referenceQuery, /aliasSourceData\.import_media_refs/);
  assert.match(referenceQuery, /aliasSourceData\.import_media_match_paths/);
  assert.match(referenceQuery, /aliasSourceData\.import_media_placements/);
  assert.match(referenceQuery, /aliasSourceData\.import_source_file/);
  assert.match(referenceQuery, /AS answer_rows/);
  assert.match(referenceQuery, /extractMediaReferences\(row\.question_html\)/);
  assert.match(referenceQuery, /extractMediaReferences\(row\.explanation_html\)/);
  assert.match(referenceQuery, /extractMediaReferences\(answer\?\.text_html\)/);
  assert.match(referenceQuery, /canonical_inline_fallback/);
  assert.match(referenceQuery, /sourceAliasId: row\.source_alias_id/);
  assert.match(referenceQuery, /studentDeliveryProtected: row\.student_delivery_protected === true/);
});

test('private import image, audio, and video links are collection-scoped while protected canonical links remain unchanged', () => {
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS content_source_alias_media/);
  assert.match(postgres, /UNIQUE\(source_alias_id, media_ref\)/);
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS content_source_alias_videos/);
  const saveMatches = postgres.slice(
    postgres.indexOf('export async function saveContentMediaMatchBatch'),
    postgres.indexOf('export async function saveContentMediaMatches'),
  );
  assert.match(saveMatches, /INSERT INTO content_source_alias_media/);
  assert.match(saveMatches, /ON CONFLICT \(source_alias_id, media_ref\) DO UPDATE SET/);
  assert.match(saveMatches, /student_delivery_protected/);
  assert.match(saveMatches, /if \(!studentDeliveryProtected\)/);
  assert.match(saveMatches, /INSERT INTO content_question_media/);
  assert.match(saveMatches, /protectedAliasLinks/);
  const saveVideoMatches = postgres.slice(
    postgres.indexOf('export async function saveContentVideoLinksBatch'),
    postgres.indexOf('export async function saveContentMediaMatchBatch'),
  );
  assert.match(saveVideoMatches, /INSERT INTO content_source_alias_videos/);
  assert.match(saveVideoMatches, /ON CONFLICT \(source_alias_id,media_ref\) DO UPDATE SET/);
  assert.match(saveVideoMatches, /if \(!studentDeliveryProtected\)/);
  assert.match(saveVideoMatches, /if \(match\.studentDeliveryProtected !== true\)/);
  assert.match(saveVideoMatches, /INSERT INTO content_question_videos/);
  const mediaAudit = postgres.slice(
    postgres.indexOf('export async function auditContentMediaLinks'),
    postgres.indexOf('export async function createContentImportJob'),
  );
  assert.match(mediaAudit, /LEFT JOIN content_source_alias_media/);
  assert.match(mediaAudit, /ON input\.source_alias_id IS NULL/);
  const videoAudits = postgres.slice(
    postgres.indexOf('export async function auditContentVideoMappings'),
    postgres.indexOf('export async function saveContentVideoAsset'),
  );
  assert.match(videoAudits, /LEFT JOIN content_source_alias_videos/g);
  assert.match(videoAudits, /NULLIF\(x\.source_alias_id,''\)::uuid/g);
  assert.match(videoAudits, /ON input\.source_alias_id IS NULL/g);
});

test('QBank delivery resolves collection-scoped image, audio, and video links from the selected source alias', () => {
  const projection = postgres.slice(
    postgres.indexOf('function qbankQuestionProjection'),
    postgres.indexOf('export async function listContentQbankQuestions'),
  );
  assert.match(postgres, /function contentQuestionDeliveryMediaReadySql/);
  assert.match(projection, /a\.id AS source_alias_id/);
  assert.match(projection, /contentQuestionDeliveryMediaReadySql\("q"\)/);
  assert.match(projection, /FROM content_source_alias_media am/);
  assert.match(projection, /am\.source_alias_id=delivery\.source_alias_id/);
  assert.match(projection, /FROM content_source_alias_videos av/);
  assert.match(projection, /av\.source_alias_id=delivery\.source_alias_id/);
  assert.match(projection, /source_priority/);
  assert.match(projection, /DISTINCT ON \(candidate\.media_ref\)/);
  assert.match(projection, /a\.collection_id=ANY\(/);
  assert.match(projection, /delivery\.collection_id/);
});

test('every question import durably preserves its collection-scoped media manifest on the source alias', () => {
  const importBatch = postgres.slice(
    postgres.indexOf('export async function importContentQuestionBatch'),
    postgres.indexOf('export async function previewStep1CollectionTaxonomyRepair'),
  );
  for (const field of [
    'import_media_refs',
    'import_media_placements',
    'import_media_match_paths',
    'import_source_file',
    'import_media_manifest_version',
  ]) assert.match(importBatch, new RegExp(field));
  assert.match(importBatch, /ON CONFLICT \(exam_track, source_namespace, collection_key, source_item_id\) DO UPDATE SET/);
  assert.match(importBatch, /source_data=COALESCE\(content_source_aliases\.source_data,'\{\}'::jsonb\) \|\| EXCLUDED\.source_data/);
});

test('question imports collapse canonical duplicates before the answer upsert', () => {
  const importBatch = postgres.slice(
    postgres.indexOf('export async function importContentQuestionBatch'),
    postgres.indexOf('export async function previewStep1CollectionTaxonomyRepair'),
  );
  assert.match(importBatch, /const preferredRows = new Map\(\)/);
  assert.match(importBatch, /const answerPayload = \[\.\.\.preferredRows\.values\(\)\]\.flatMap/);
  assert.doesNotMatch(importBatch, /const answerPayload = rows\.flatMap/);
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

test('owner-controlled all-students testing release is explicit, reversible, and still structure-gated', () => {
  assert.match(server, /testingPhaseRelease = req\.body\.testing_phase === true/);
  assert.match(server, /testingPhaseRelease,/);
  assert.match(server, /testing_phase_release: testingPhaseRelease/);
  assert.match(postgres, /testingPhaseRelease = false/);
  assert.match(postgres, /AYLAMED_TESTING_RELEASE_GATE_BLOCKED/);
  assert.match(postgres, /testing_answer_shape_ready_count/);
  assert.match(postgres, /five_answer_shape_ready_count/);
  assert.match(postgres, /COUNT\(\*\) FROM content_answers answer WHERE answer\.question_id=collection_questions\.id\)>=2/);
  assert.match(postgres, /at least two answer choices, and exactly one correct answer/);
  assert.match(postgres, /native_answer_shape_ready_count/);
  assert.match(postgres, /\)=5/);
  assert.match(postgres, /taxonomy_complete_count/);
  assert.match(postgres, /publishAllRequested && testingPhaseRelease !== true/);
  assert.match(postgres, /if \(unpublishAllRequested && effectiveDestinationRows/);
});

test('authorized launch banks use a separate count-locked and reversible release path', () => {
  assert.match(server, /content-registry\/collections\/:collectionId\/approve-authorized/);
  assert.match(server, /content-registry\/collections\/:collectionId\/publish-authorized/);
  assert.match(server, /content-registry\/collections\/:collectionId\/unpublish-authorized/);
  assert.match(server, /requiredConfirmation = `APPROVE AUTHORIZED \$\{expectedQuestionCount\}`/);
  assert.match(server, /requiredConfirmation = `PUBLISH AUTHORIZED \$\{expectedQuestionCount\}`/);
  assert.match(server, /requiredConfirmation = `UNPUBLISH AUTHORIZED \$\{expectedQuestionCount\}`/);
  assert.match(server, /allowAuthorizedExternal: true/);
  assert.match(server, /requireAuthorizedExternal: true/);
  assert.match(postgres, /AUTHORIZED_EXTERNAL_COLLECTION_REQUIRED/);
  assert.match(postgres, /AUTHORIZED_CONTENT_MEDIA_GATE_BLOCKED/);
  assert.match(postgres, /AUTHORIZED_CONTENT_PRIVATE_APPROVAL_GATE_BLOCKED/);
  assert.match(postgres, /authorized_private_approval_ready_count/);
  assert.match(postgres, /delivery_media_ready_count/);
  assert.match(server, /incomplete_required_media_excluded_from_delivery: true/);
  assert.match(server, /destinations_enabled: \[\]/);
});

test('overview uses a bounded read-only QBank publication status instead of the full collection table', () => {
  assert.match(postgres, /getContentGlobalQbankPublicationState/);
  assert.match(postgres, /c\.source_profile='aylamed_original'/);
  assert.match(postgres, /c\.status='approved'/);
  assert.match(postgres, /destination\.destination='aylamed_qbank'/);
  assert.match(postgres, /automatic_publication: false/);
  assert.match(server, /app\.get\("\/api\/ayla\/admin\/qbank\/global-publication"/);
  assert.match(server, /getContentGlobalQbankPublicationState/);
  assert.doesNotMatch(
    server.slice(
      server.indexOf('app.get("/api/ayla/admin/qbank/global-publication"'),
      server.indexOf('app.post("/api/ayla/admin/global-testing-access"'),
    ),
    /updateContentCollectionControls|publishAllOwnedCollection|changeGlobalTestingAccess/,
  );
});

test('collection registry reads are page-first, single-pass, indexed, and cancelled at the database deadline', () => {
  const listQuery = postgres.slice(
    postgres.indexOf('export async function listContentCollections'),
    postgres.indexOf('export async function getContentGlobalQbankPublicationState'),
  );
  const readHelper = postgres.slice(
    postgres.indexOf('function contentRegistryReadTimeoutError'),
    postgres.indexOf('export function contentRegistryStatus'),
  );
  const publicationPanelRead = server.slice(
    server.indexOf('async function aylaListAllContentCollections'),
    server.indexOf('function aylaContentCollectionDestinationEnabled'),
  );

  assert.doesNotMatch(postgres, /idx_content_alias_collection_question/);
  assert.doesNotMatch(postgres, /idx_content_import_jobs_draft_recovery/);
  assert.match(readPathIndexes, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_alias_collection_question/);
  assert.match(readPathIndexes, /CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_content_import_jobs_draft_recovery/);
  assert.match(listQuery, /WITH selected_collections AS MATERIALIZED/);
  assert.match(listQuery, /LIMIT \$\$\{values\.length - 1\} OFFSET \$\$\{values\.length\}/);
  assert.ok(
    listQuery.indexOf('LIMIT $${values.length - 1}') < listQuery.indexOf('JOIN content_source_aliases'),
    'collections must be paged before question/media joins',
  );
  assert.match(listQuery, /question_readiness AS MATERIALIZED/);
  assert.equal((listQuery.match(/contentQuestionMediaReadySql\("q"\)/g) || []).length, 1);
  assert.match(listQuery, /destination_rollup AS/);
  assert.doesNotMatch(listQuery, /COUNT\(DISTINCT/);

  assert.match(readHelper, /BEGIN READ ONLY/);
  assert.match(readHelper, /set_config\('statement_timeout'/);
  assert.match(readHelper, /error\?\.code === "57014"/);
  assert.match(readHelper, /client\?\.release\(\)/);
  assert.match(readHelper, /waitForContentRegistryReadSchema/);
  assert.match(readHelper, /Content registry is still initializing/);
  assert.match(listQuery, /safeTimeoutMs - \(Date\.now\(\) - startedAt\)/);
  assert.doesNotMatch(publicationPanelRead, /Promise\.race/);
  assert.match(publicationPanelRead, /deadline - Date\.now\(\)/);
  assert.match(publicationPanelRead, /timeoutMs: remainingMs/);
});

test('registry snapshots are shared across the table and publication panel and invalidated after writes', () => {
  const listQuery = postgres.slice(
    postgres.indexOf('export async function listContentCollections'),
    postgres.indexOf('export async function getContentGlobalQbankPublicationState'),
  );
  const publicationPanelRead = server.slice(
    server.indexOf('async function aylaListAllContentCollections'),
    server.indexOf('function aylaContentCollectionDestinationEnabled'),
  );
  assert.match(postgres, /createBoundedSnapshotCache/);
  assert.match(postgres, /NEXTGEN_CONTENT_REGISTRY_SNAPSHOT_TTL_MS/);
  assert.match(listQuery, /contentRegistryReadSnapshots\.read\(snapshotKey/);
  assert.match(publicationPanelRead, /listContentCollections\(\{/);
  assert.doesNotMatch(publicationPanelRead, /queryContentRegistryRead/);

  for (const functionName of [
    'applyGuardedUworldCleanup',
    'applyAylaOriginalMcqRepair',
    'saveContentVideoLinksBatch',
    'saveContentVideoMatch',
    'saveContentMediaMatchBatch',
    'importContentQuestionBatch',
    'repairStep1CollectionTaxonomy',
    'updateContentCollectionControls',
    'upsertContentTaxonomyMapping',
    'reviewContentTaxonomyMapping',
    'upsertContentQuestionTaxonomyOverride',
    'removeContentQuestionTaxonomyOverride',
  ]) {
    const start = postgres.indexOf(`export async function ${functionName}`);
    const end = postgres.indexOf('\nexport ', start + 1);
    assert.ok(start >= 0, `${functionName} must exist`);
    assert.match(postgres.slice(start, end < 0 ? undefined : end), /commitContentRegistryMutation/);
  }

  for (const functionName of [
    'createContentMediaImportJob',
    'finishContentMediaImportJob',
    'createContentVideoImportJob',
    'finishContentVideoImportJob',
    'saveContentVideoAsset',
    'createContentImportJob',
    'finishContentImportPreview',
    'setContentImportJobStatus',
    'claimContentImportDraft',
  ]) {
    const start = postgres.indexOf(`export async function ${functionName}`);
    const end = postgres.indexOf('\nexport ', start + 1);
    assert.ok(start >= 0, `${functionName} must exist`);
    assert.match(postgres.slice(start, end < 0 ? undefined : end), /queryContentRegistryMutation/);
  }
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
  assert.match(server, /const sourceProfile = ""/);
  assert.match(server, /if \(!roadmapAssignmentId && purpose !== "baseline_diagnostic"\)/);
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

test('QBank taxonomy coverage excludes assessment-only NBME collections', () => {
  const reviewQueue = postgres.slice(
    postgres.indexOf('export async function listContentTaxonomyReviewQueue'),
    postgres.indexOf('export async function getContentTaxonomyProviderPairEvidence'),
  );
  const pairEvidence = postgres.slice(
    postgres.indexOf('export async function getContentTaxonomyProviderPairEvidence'),
    postgres.indexOf('export async function upsertContentQuestionTaxonomyOverride'),
  );
  const coverage = postgres.slice(
    postgres.indexOf('export async function getContentTaxonomyCoverage'),
    postgres.indexOf('export async function listContentHubVideos'),
  );

  for (const query of [reviewQueue, pairEvidence, coverage]) {
    assert.match(query, /JOIN content_collections/);
    assert.match(query, /destination='aylamed_qbank'/);
  }
  assert.match(coverage, /WITH qbank_questions AS/);
  assert.match(coverage, /FROM qbank_questions q GROUP BY 1/);
  assert.doesNotMatch(reviewQueue, /aylamed_nbme/);
  assert.doesNotMatch(pairEvidence, /aylamed_nbme/);
  assert.doesNotMatch(coverage, /aylamed_nbme/);
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
    'https://nextgenusmle.live', 'https://www.nextgenusmle.live',
    'https://mediumslateblue-otter-394719.hostingersite.com',
    'https://paleturquoise-quail-255896.hostingersite.com',
  ]) assert.match(server, new RegExp(origin.replaceAll('.', '\\.')));
  assert.match(server, /NEXTGEN_CORS_ALLOWED_ORIGINS/);
  assert.match(server, /LEGACY_LMS_HOSTNAMES[\s\S]*?lms\.nextgenusmlelms\.com/);
  assert.match(server, /ngSafeExternalLibraryBaseUrl[\s\S]*?LEGACY_LMS_HOSTNAMES\.has/);
  assert.doesNotMatch(server, /usmlecorner\.com/);
  assert.doesNotMatch(server, /http:\/\/localhost:5173/);
  assert.doesNotMatch(server, /host\.endsWith\("\.nextgenusmlelms\.com"\)/);
  assert.doesNotMatch(server, /origin:\s*true/);
});

test('current LMS links and support replies use the replacement live domain', () => {
  assert.match(server, /https:\/\/nextgenusmle\.live\/login/);
  assert.match(server, /https:\/\/nextgenusmle\.live\/student\/live-sessions/);
  assert.match(server, /support@nextgenusmle\.live/);
});
