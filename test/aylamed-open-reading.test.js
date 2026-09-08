import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeAylaOpenReading, buildAylaOpenReadingCatalog, safeOpenReadingSourceUrl } from '../lib/aylamed-open-reading.js';
import { buildAylaLibraryCatalog, buildAylaLibraryReader, selectAylaRoadmapReading } from '../lib/aylamed-library.js';
import { normalizeAylaShellExamTrack } from '../lib/aylamed-student-shell.js';

const reference = (overrides = {}) => ({ id: 'OPEN-RN-1', type: 'external_reading', examTrackId: 'nclex',
  title: 'Nursing Fundamentals 2e', bookTitle: 'Nursing Fundamentals 2e', edition: 'Second edition (2024)',
  system: 'Nursing Foundations', topic: 'Nursing fundamentals', approved: true, status: 'active',
  authorizationStatus: 'licensed', verificationStatus: 'verified', sourceAccessMode: 'open',
  sourceLabelVisible: true, sourceLabel: 'Open RN | WisTech Open', sourceUrl: 'https://wtcs.pressbooks.pub/nursingfundamentals/',
  openReading: { publisher: 'WisTech Open', editors: ['Kimberly Ernstmeyer', 'Elizabeth Christman'],
    copyright: 'Copyright 2024 WisTech Open', attribution: 'Open RN, Nursing Fundamentals 2e, edited by Ernstmeyer and Christman.',
    license_id: 'CC-BY-4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/',
    context_note: 'Supplemental nursing foundations. Wisconsin curriculum and law; 2023 RN/PN plans. Not full 2026 coverage.',
    chapters: [{ title: '5. Safety', url: 'https://wtcs.pressbooks.pub/nursingfundamentals/chapter/5-1-safety-introduction/' }] },
  ...overrides });

test('external reference requires exact exam, explicit approval, licensed rights and visible attribution', () => {
  const result = normalizeAylaOpenReading(reference(), { examTrack: 'nclex' });
  assert.equal(result.reader.mode, 'external_open_reading'); assert.equal(result.open_reading.free_access, true);
  assert.deepEqual(result.open_reading.editors, ['Kimberly Ernstmeyer', 'Elizabeth Christman']);
  for (const exam of ['usmle_step_1', 'usmle_step_2_ck', 'usmle_step_3', 'mccqe', 'amc', 'plab', 'invented']) assert.equal(normalizeAylaOpenReading(reference(), { examTrack: exam }), null);
  for (const patch of [{ approved: false }, { approved: undefined }, { status: 'draft' }, { status: 'quarantined' }, { authorizationStatus: 'pending_review' },
    { verificationStatus: 'not_verified' }, { verificationStatus: 'pending_verified' }, { sourceLabelVisible: false }, { sourceAccessMode: 'protected' }, { edition: '' }, { openReading: {} }]) {
    assert.equal(normalizeAylaOpenReading(reference(patch), { examTrack: 'nclex' }), null, JSON.stringify(patch));
  }
  assert.ok(normalizeAylaOpenReading(reference({ approved: false, status: 'draft', verificationStatus: 'pending_review' }), { examTrack: 'nclex', requireApproval: false }), 'Draft metadata may be validated without publishing it');
});

test('only the explicitly supported HTTPS publisher links and license are emitted', () => {
  const invalid = ['javascript:alert(1)', 'data:text/html,hi', 'http://wtcs.pressbooks.pub/nursingfundamentals/', 'https://wtcs.pressbooks.pub.evil.test/nursingfundamentals/',
    'https://user:pass@wtcs.pressbooks.pub/nursingfundamentals/', 'https://wtcs.pressbooks.pub:8443/nursingfundamentals/', 'https://wtcs.pressbooks.pub/nursingfundamentals/?redirect=https://evil.test',
    'https://127.0.0.1/nursingfundamentals/', 'https://wtcs.pressbooks.pub/other-book/', 'https://wtcs.pressbooks.pub/nursingfundamentals/../../other-book/'];
  for (const url of invalid) { assert.equal(safeOpenReadingSourceUrl(url), null); assert.equal(normalizeAylaOpenReading(reference({ sourceUrl: url }), { examTrack: 'nclex' }), null); }
  const wrongLicense = reference(); wrongLicense.openReading.license_url = 'https://evil.test/';
  assert.equal(normalizeAylaOpenReading(wrongLicense, { examTrack: 'nclex' }), null);
  const badChapter = reference(); badChapter.openReading.chapters[0].url = 'javascript:bad()';
  assert.equal(normalizeAylaOpenReading(badChapter, { examTrack: 'nclex' }), null);
  badChapter.openReading.chapters = [null];
  assert.equal(normalizeAylaOpenReading(badChapter, { examTrack: 'nclex' }), null);
  const mixedCatalog = buildAylaOpenReadingCatalog([badChapter, reference({ id: 'valid' })], { examTrack: 'nclex' });
  assert.deepEqual(mixedCatalog.resources.map((row) => row.id), ['valid']);
  const safe = normalizeAylaOpenReading(reference({ privateObjectKey: 'secret', studentId: 'someone' }), { examTrack: 'nclex' });
  assert.doesNotMatch(JSON.stringify(safe), /privateObjectKey|someone|reader_pages|page_count/);
});

test('chapter search finds one reference; it never becomes nineteen books, fake pages or roadmap grounding', () => {
  const rows = [reference()];
  assert.equal(buildAylaOpenReadingCatalog(rows, { examTrack: 'nclex', filters: { search: 'safety' } }).resources.length, 1);
  assert.equal(buildAylaOpenReadingCatalog(rows, { examTrack: 'nclex', filters: { search: 'unmatched' } }).resources.length, 0);
  assert.equal(buildAylaOpenReadingCatalog(rows, { examTrack: 'nclex', filters: { system: 'Cardiovascular' } }).resources.length, 0);
  assert.equal(buildAylaOpenReadingCatalog(rows, { examTrack: 'nclex', filters: { system: 'Nursing Foundations' } }).resources.length, 1);
  assert.equal(buildAylaLibraryCatalog({ resources: rows, examTrack: 'nclex' }).books.length, 0);
  assert.equal(buildAylaLibraryReader(rows[0], { examTrack: 'nclex' }), null);
  assert.equal(selectAylaRoadmapReading({ resources: rows, examTrack: 'nclex' }).resource, null);
});

const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
function functionText(name) { const start = source.indexOf(`function ${name}(`); const end = source.indexOf('\nfunction ', start + 1); return source.slice(start, end); }

test('actual resource importer preserves external metadata and never infers editorial approval from legacy defaults', () => {
  const context = { normalizeAylaOpenReading,
    aylaV189CleanText: (value) => String(value || '').trim(),
    aylaCleanArray: (value) => Array.isArray(value) ? value : [], aylaV189PageRange: () => '',
    aylaNumber: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    aylaCanonicalExamTrack: normalizeAylaShellExamTrack, AYLA_EXAM_REGISTRY: { nclex: { label: 'NCLEX' } },
    aylaPilotContentScope: () => ({}), aylaId: () => 'new-id', aylaNow: () => '2026-09-08T00:00:00Z', aylaV189VimeoEmbed: () => '',
  };
  vm.createContext(context);
  vm.runInContext(source.match(/const AYLA_V189_RESOURCE_TYPES = new Set\(\[[\s\S]*?\]\);/)[0], context);
  vm.runInContext(functionText('aylaV189ResourceType'), context);
  vm.runInContext(functionText('aylaV189NormalizeResource'), context);
  vm.runInContext(functionText('aylaV190ResourceValidation'), context);
  const input = reference(); delete input.approved; delete input.verificationStatus; delete input.status;
  const draft = context.aylaV189NormalizeResource(input);
  assert.equal(draft.type, 'external_reading'); assert.equal(draft.approved, false); assert.equal(draft.verificationStatus, 'pending_review'); assert.equal(draft.status, 'draft');
  assert.equal(context.aylaV190ResourceValidation(draft).valid, true);
  assert.equal(normalizeAylaOpenReading(draft, { examTrack: 'nclex' }), null);
  assert.equal(draft.openReading.chapters[0].url, input.openReading.chapters[0].url);
  const approved = context.aylaV189NormalizeResource({ approved: true, status: 'active', verificationStatus: 'verified' }, draft);
  assert.ok(normalizeAylaOpenReading(approved, { examTrack: 'nclex' }));
  const revoked = context.aylaV189NormalizeResource({ approved: false }, approved);
  assert.equal(normalizeAylaOpenReading(revoked, { examTrack: 'nclex' }), null);
  assert.equal(context.aylaV190ResourceValidation({ ...approved, sourceUrl: 'https://evil.test/' }).valid, false);
});

function routeHarness() {
  let handler; const calls = [];
  const context = { app: { get: (path, fn) => { handler = fn; } },
    aylaV189RequireStudent: async (req, studentId, feature) => { calls.push({ stage: 'auth', studentId, feature }); if (!req.allowed) throw Object.assign(new Error('Access unavailable'), { statusCode: 403 }); return { student: { id: studentId, examTrackId: req.exam || 'nclex' }, db: { aylaResources: req.resources || [] } }; },
    aylaV211EligibleReadings: async () => ({ resources: [], warning: null }),
    aylaV211ReadingAssignments: () => [], buildAylaLibraryCatalog, buildAylaOpenReadingCatalog,
    aylaValues: (db, key) => db[key] || [], aylaCleanArray: (value) => Array.isArray(value) ? value : [], aylaCanonicalExamTrack: normalizeAylaShellExamTrack,
    aylaV189SystemProgress: () => { throw new Error('External catalog must not recompute system progress'); },
    aylaPilotContentScope: (row) => ({ pilotOnly: Boolean(row.pilotOnly) }),
    aylaPilotContentVisibleToStudent: (row, student) => !row.pilotOnly || (row.pilotStudentIds || []).includes(student.id), aylaStep1PilotVimeoVisibleToStudent: () => true,
    aylaResourcePublishedFor: (db, row, exam, destination) => { calls.push({ stage: 'publication', type: context.aylaPublicationResourceType(row), exam, destination }); return { allowed: row.testPublished !== false }; },
    aylaNumber: (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback,
    AYLA_V189_RESOURCE_TYPES: new Set(['book', 'reading', 'revision_sheet', 'external_reading']),
    aylaSendOk: (res, body) => ({ status: 200, body }), aylaSendError: (res, status, error) => ({ status, body: { error } }),
  };
  vm.createContext(context);
  for (const name of ['aylaV189ResourceType', 'aylaPublicationResourceType', 'aylaV189RelevantResources']) vm.runInContext(functionText(name), context);
  const start = source.indexOf('app.get("/api/ayla/students/:studentId/library",');
  const end = source.indexOf('app.get("/api/ayla/students/:studentId/library/resources/:resourceId",', start);
  vm.runInContext(source.slice(start, end), context);
  return { calls, run: async (options = {}) => handler({ params: { studentId: 'student1' }, query: {}, allowed: true, ...options }, { setHeader() {} }) };
}

test('actual library route keeps authentication, owner/pilot/publication/exam controls for open references', async () => {
  const app = routeHarness();
  assert.equal((await app.run({ allowed: false, resources: [reference()] })).status, 403);
  assert.equal(app.calls.length, 1);
  const response = await app.run({ resources: [reference(), reference({ id: 'hidden', testPublished: false }), reference({ id: 'private', ownerStudentId: 'student2' }), reference({ id: 'pilot', pilotOnly: true, pilotStudentIds: ['student2'] })] });
  assert.equal(response.status, 200); assert.equal(response.body.catalog.external_readings.length, 1);
  assert.equal(response.body.catalog.external_reading_count, 1); assert.equal(response.body.catalog.books.length, 0);
  assert.ok(app.calls.filter((call) => call.stage === 'publication').every((call) => call.type === 'book' && call.destination === 'content_hub'));
  for (const exam of ['usmle_step_1', 'usmle_step_2_ck', 'usmle_step_3', 'mccqe', 'amc', 'plab']) assert.equal((await app.run({ exam, resources: [reference()] })).body.catalog.external_reading_count, 0);
  assert.equal((await app.run({ resources: [reference()], query: { search: 'safety' } })).body.catalog.external_reading_count, 1);
});
