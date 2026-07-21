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

test('question ID display policy supports internal, source, both, and hidden modes', () => {
  for (const mode of ['internal', 'source', 'both', 'hidden']) assert.match(postgres, new RegExp(`'${mode}'`));
  for (const mode of ['provider', 'neutral', 'hidden']) assert.match(postgres, new RegExp(`'${mode}'`));
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
