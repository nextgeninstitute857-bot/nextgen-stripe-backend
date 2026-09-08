import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { aylaNclexDiagnosticSystems } from '../lib/aylamed-nclex-diagnostic.js';
import { LIMITS, prepareQuestionTaxonomyBatch, parseBatchResultJsonl, separateClinicalHtml, validateQuestionTaxonomyBatchResults } from '../lib/question-taxonomy-batch-preparation.js';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const fingerprint = 'a'.repeat(64);
const taxonomy = { system_key: 'internal_medicine', subsystem_key: 'cardiovascular', topic_key: 'aortic_stenosis', subtopic_key: 'diagnosis',
  labels: { system: 'Internal Medicine', subsystem: 'Cardiovascular', topic: 'Aortic stenosis', subtopic: 'Diagnosis' } };
const question = (number = 1, extra = {}) => ({ id: id(number), evidence_fingerprint: fingerprint, exam_track: 'usmle-step-2',
  question_html: '<p>Synthetic clinical stem for a classification fixture.</p>', explanation_html: '<p>Synthetic explanation supports the tested concept.</p>',
  correct_answer_id: 1, answers: [{ answer_id: 1, text_html: 'Synthetic option one' }, { answer_id: 2, text_html: 'Synthetic option two' }],
  allowed_systems: ['Internal Medicine'], nclex_variant: null, variant_evidence: [], classification_blocked_reason: null,
  override: null, native: { labels: { system: 'Synthetic native label' } }, sources: [], taxonomy: {}, ...extra });
const page = (questions = [question()]) => ({ evidence_version: 'question-taxonomy-review-v1', exam_track: questions[0].exam_track, questions, count: questions.length, has_more: false });
const prepare = (questions, options = {}) => prepareQuestionTaxonomyBatch(page(questions), { model: 'explicit-fixture-model', ...options });
const proposal = (expected, extra = {}) => ({ question_id: expected.question_id, evidence_fingerprint: expected.evidence_fingerprint, state: 'NEEDS_REVIEW',
  taxonomy, reason: 'Synthetic evidence supports this clinical learning objective.', confidence_percent: 78,
  ambiguity_flags: [], media_review_required: expected.media_review_required, ...extra });
const result = (expected, extra = {}) => ({ custom_id: expected.custom_id, error: null, response: { status_code: 200, body: {
  status: 'completed', error: null, incomplete_details: null, output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: JSON.stringify(proposal(expected, extra)) }] }] } } });
const clone = value => structuredClone(value);

test('preparation preserves complete long clinical evidence, tables, choices and untrusted instructions', () => {
  const secretMarker = 'SOURCE_INSTRUCTION_DO_NOT_EXECUTE';
  const stem = `<p>${'Full synthetic evidence. '.repeat(600)}</p><table><tr><td>A</td><td>B</td></tr></table><p>${secretMarker}</p>`;
  const q = question(1, { question_html: stem, explanation_html: '<table><tr><td>Explanation table</td></tr></table>',
    answers: [{ answer_id: 1, text_html: '<table><tr><td>Choice table</td></tr></table>' }, { answer_id: 2, text_html: 'Other choice' }],
    override: { status: 'active', revision: 7 } });
  const { jsonl, manifest } = prepare([q]);
  const request = JSON.parse(jsonl);
  assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/responses');
  assert.equal(request.body.model, 'explicit-fixture-model'); assert.equal(request.body.store, false);
  assert.equal(request.body.text.format.type, 'json_schema'); assert.equal(request.body.text.format.strict, true);
  assert.deepEqual(request.body.text.format.schema.properties.question_id.enum, [q.id]);
  assert.match(request.body.input[0].content[0].text, /UNTRUSTED DATA/);
  assert.ok(!request.body.input[0].content[0].text.includes(secretMarker));
  const source = JSON.parse(request.body.input[1].content[0].text).untrusted_question_evidence;
  assert.equal(source.documents.stem.original_html, stem);
  assert.equal(source.documents.stem.tables_html.length, 1);
  assert.ok(source.documents.stem.html_without_tables.includes('[TABLE 1]'));
  assert.equal(source.documents.explanation.original_html, q.explanation_html);
  assert.equal(source.documents.choices[0].original_html, q.answers[0].text_html);
  assert.equal(source.correct_answer_id, 1); assert.equal(source.evidence_fingerprint, fingerprint);
  assert.equal(manifest.expected[0].expected_override_revision, 7);
  assert.equal(manifest.estimate.request_jsonl_bytes, Buffer.byteLength(jsonl));
  assert.match(manifest.estimate.method, /heuristic only/);
  assert.equal(manifest.estimate.price_estimate, null);
  assert.equal(manifest.estimate.model_compatibility_verified, false);
});

test('nested tables and malformed markup preserve every original byte and media flags', () => {
  const html = '<p>Start</p><table><tr><td><table><tr><td>N</td></tr></table></td></tr></table><img src="fixture.png"><table>Unclosed';
  const doc = separateClinicalHtml(html);
  assert.equal(doc.original_html, html); assert.equal(doc.tables_html.length, 1);
  assert.ok(doc.tables_html[0].includes('<table><tr><td>N'));
  assert.equal(doc.malformed_table_markup, true); assert.deepEqual(doc.media_flags, ['img']);
  assert.ok(doc.html_without_tables.includes('<table>Unclosed'));
  const prepared = prepare([question(1, { question_html: html })]);
  assert.equal(prepared.manifest.expected[0].media_review_required, true);
  const response = result(prepared.manifest.expected[0], { media_review_required: false });
  assert.throws(() => validateQuestionTaxonomyBatchResults(prepared.manifest, [response]), /cannot dismiss/);
});

test('caps at 25 requests and holds count overflow without losing identity or pagination', () => {
  const evidence = page(Array.from({ length: 30 }, (_, i) => question(i + 1)));
  evidence.has_more = true; evidence.next_after = id(30);
  const prepared = prepareQuestionTaxonomyBatch(evidence, { model: 'explicit-fixture-model' });
  assert.equal(prepared.manifest.prepared_count, 25); assert.equal(prepared.manifest.held_count, 5);
  assert.equal(prepared.jsonl.trim().split('\n').length, 25);
  assert.equal(prepared.manifest.page_has_more, true); assert.equal(prepared.manifest.next_after, id(30));
  assert.deepEqual(prepared.manifest.held.map(row => row.question_id), [26, 27, 28, 29, 30].map(id));
  assert.ok(prepared.manifest.held.every(row => row.reason === 'question_limit'));
  assert.throws(() => prepare([question()], { maxQuestions: 26 }), /no greater than 25/);
});

test('UTF-8 request and batch byte bounds hold oversized items, never truncate', () => {
  const oversized = question(1, { question_html: '🩺'.repeat(LIMITS.requestBytes / 4) });
  const prepared = prepare([oversized, question(2)]);
  assert.equal(prepared.manifest.prepared_count, 1); assert.equal(prepared.manifest.expected[0].question_id, id(2));
  assert.equal(prepared.manifest.held[0].reason, 'request_payload_too_large');
  assert.equal(prepared.manifest.held[0].evidence_fingerprint, fingerprint);
  const oneSize = prepare([question()]).manifest.estimate.request_jsonl_bytes;
  const limited = prepare([question(), question(2)], { maxBatchBytes: oneSize });
  assert.equal(limited.manifest.prepared_count, 1); assert.equal(limited.manifest.held[0].reason, 'batch_payload_limit');
  assert.equal(Buffer.byteLength(limited.jsonl), oneSize);
  assert.throws(() => prepare([question()], { maxRequestBytes: LIMITS.requestBytes + 1 }), /no greater/);
  assert.throws(() => prepare([question()], { maxBatchBytes: LIMITS.batchBytes + 1 }), /no greater/);
});

test('missing, conflicting and blocked NCLEX evidence stays held; exact RN and PN scopes prepare', () => {
  const nclex = variant => question(1, { exam_track: 'nclex', nclex_variant: variant, allowed_systems: aylaNclexDiagnosticSystems(variant), variant_evidence: [{ variant }] });
  for (const variant of ['nclex_rn', 'nclex_pn']) assert.equal(prepare([nclex(variant)]).manifest.prepared_count, 1);
  for (const patch of [
    { nclex_variant: null }, { variant_evidence: [] }, { variant_evidence: [{ variant: 'nclex_pn' }] },
    { allowed_systems: ['Internal Medicine'] }, { classification_blocked_reason: 'nclex_variant_conflict' },
  ]) {
    const prepared = prepare([{ ...nclex('nclex_rn'), ...patch }]);
    assert.equal(prepared.manifest.prepared_count, 0); assert.equal(prepared.jsonl, '');
    assert.equal(prepared.manifest.held_count, 1);
  }
});

test('incomplete evidence and active override without revision stay held', () => {
  for (const patch of [{ explanation_html: '' }, { correct_answer_id: 99 }, { answers: [] },
    { answers: [{ answer_id: 1, text_html: 'a' }, { answer_id: '1', text_html: 'b' }] },
    { override: { status: 'active' } }]) {
    assert.equal(prepare([question(1, patch)]).manifest.prepared_count, 0);
  }
});

test('requires explicit model and rejects wrong exams, duplicate IDs and guessed fingerprints', () => {
  assert.throws(() => prepareQuestionTaxonomyBatch(page()), /explicit --model/);
  assert.throws(() => prepare([question()], { model: ' ' }), /explicit --model/);
  assert.throws(() => prepare([question(), question()]), /Duplicate question UUID/);
  assert.throws(() => prepare([question(), question(2, { exam_track: 'plab' })]), /out-of-exam/);
  assert.throws(() => prepare([question(1, { evidence_fingerprint: 'guessed' })]), /server fingerprint/);
  assert.throws(() => prepareQuestionTaxonomyBatch({ ...page(), count: 99 }, { model: 'explicit-fixture-model' }), /count/);
});

test('out-of-order Batch output validates exact identities and preserves proposed path and review flags', () => {
  const { manifest } = prepare([question(1), question(2)]);
  const rows = manifest.expected.map(item => result(item)).reverse();
  const validated = validateQuestionTaxonomyBatchResults(manifest, rows);
  assert.equal(validated.complete, true); assert.equal(validated.state, 'NEEDS_REVIEW');
  assert.equal(validated.artifact_type, 'classification_proposals'); assert.equal(validated.independent_review_required, true);
  assert.equal(validated.proposal_count, 2);
  assert.deepEqual(validated.proposals.map(row => row.question_id), [id(1), id(2)]);
  assert.deepEqual(validated.proposals[0].taxonomy, taxonomy);
  assert.equal(validated.proposals[0].confidence_percent, 78);
  assert.ok(!Object.hasOwn(validated, 'review_id')); assert.ok(!Object.hasOwn(validated, 'items')); assert.ok(!Object.hasOwn(validated, 'apply'));
  assert.deepEqual(parseBatchResultJsonl(rows.map(row => JSON.stringify(row)).join('\r\n') + '\r\n'), rows);
});

test('missing, duplicate, unknown or misassociated results reject the entire artifact', () => {
  const { manifest } = prepare([question(1), question(2)]);
  const rows = manifest.expected.map(item => result(item));
  assert.throws(() => validateQuestionTaxonomyBatchResults(manifest, rows.slice(1)), /Missing results/);
  assert.throws(() => validateQuestionTaxonomyBatchResults(manifest, [rows[0], rows[0]]), /Duplicate/);
  assert.throws(() => validateQuestionTaxonomyBatchResults(manifest, [{ ...rows[0], custom_id: 'unknown' }, rows[1]]), /Unknown/);
  for (const patch of [{ question_id: id(2) }, { evidence_fingerprint: 'b'.repeat(64) }]) {
    assert.throws(() => validateQuestionTaxonomyBatchResults(manifest, [result(manifest.expected[0], patch), rows[1]]), /identity or server fingerprint/);
  }
});

test('strict result contract rejects approval, fabricated systems, sentinels, raw stems and extra fields', () => {
  const { manifest } = prepare([question()]); const item = manifest.expected[0];
  for (const patch of [
    { state: 'APPROVED' }, { confidence_percent: 101 }, { approved: true }, { reason: 'short' }, { ambiguity_flags: ['x', 'x'] },
    { taxonomy: { ...taxonomy, extra: 'x' } },
    { taxonomy: { ...taxonomy, system_key: 'made_up', labels: { ...taxonomy.labels, system: 'Made up' } } },
    { taxonomy: { ...taxonomy, topic_key: 'unknown', labels: { ...taxonomy.labels, topic: 'Unknown' } } },
    { taxonomy: { ...taxonomy, topic_key: 'which_of_the_following', labels: { ...taxonomy.labels, topic: 'Which of the following?' } } },
    { taxonomy: null, ambiguity_flags: [] },
  ]) assert.throws(() => validateQuestionTaxonomyBatchResults(manifest, [result(item, patch)]));
  const abstained = validateQuestionTaxonomyBatchResults(manifest, [result(item, { taxonomy: null, ambiguity_flags: ['insufficient_evidence'], confidence_percent: 0 })]);
  assert.equal(abstained.proposals[0].taxonomy, null); assert.equal(abstained.proposals[0].state, 'NEEDS_REVIEW');
});

test('API failures, refusals, incomplete and malformed output remain visible and never silently succeed', () => {
  const { manifest } = prepare([question()]); const item = manifest.expected[0];
  const variants = [];
  let row = result(item); row.error = { code: 'batch_expired', message: 'PRIVATE_ERROR_MARKER' }; variants.push(row);
  row = result(item); row.response.status_code = 429; variants.push(row);
  row = result(item); row.response.body.status = 'incomplete'; variants.push(row);
  row = result(item); row.response.body.output[1].content = [{ type: 'refusal', refusal: 'PRIVATE_REFUSAL_MARKER' }]; variants.push(row);
  row = result(item); row.response.body.output[1].content[0].text = 'PRIVATE_INVALID_JSON_MARKER'; variants.push(row);
  row = result(item); row.response.body.output.push({ type: 'function_call' }); variants.push(row);
  for (const variant of variants) {
    const validated = validateQuestionTaxonomyBatchResults(manifest, [variant]);
    assert.equal(validated.complete, false); assert.equal(validated.failed_count, 1); assert.equal(validated.proposal_count, 0);
    assert.ok(!JSON.stringify(validated).includes('PRIVATE_'));
  }
  assert.throws(() => parseBatchResultJsonl('PRIVATE_INVALID_JSON_MARKER'), /^Error: Invalid result JSON on line 1$/);
});

test('CLI runs offline, preserves source privately, refuses overwrites and gives nonzero exit for incomplete results', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ayla-offline-taxonomy-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('ayla-offline-taxonomy-'));
    return fs.rm(directory, { recursive: true, force: true });
  });
  const cli = fileURLToPath(new URL('../scripts/question-taxonomy-batch.mjs', import.meta.url));
  const fixture = path.join(directory, 'evidence.json'); const target = path.join(directory, 'batch');
  const sentinel = 'PRIVATE_CLINICAL_MARKER';
  await fs.writeFile(fixture, JSON.stringify(page([question(1, { question_html: sentinel })])));
  const denyNetwork = path.join(directory, 'deny-network.mjs');
  await fs.writeFile(denyNetwork, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns'; import {syncBuiltinESMExports} from 'node:module';
    const deny = () => { throw new Error('Network is forbidden in the offline CLI test'); };
    globalThis.fetch = deny; http.request = deny; http.get = deny; https.request = deny; https.get = deny;
    net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny; tls.connect = deny;
    dns.lookup = deny; dns.resolve = deny; syncBuiltinESMExports();`);
  const run = args => spawnSync(process.execPath, ['--import', pathToFileURL(denyNetwork).href, cli, ...args], { encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: 'NO_NETWORK_TEST_SENTINEL' } });
  const argumentsList = ['prepare', '--input', fixture, '--out-dir', target, '--model', 'explicit-fixture-model'];
  let execution = run(argumentsList); assert.equal(execution.status, 0, execution.stderr);
  assert.ok(!execution.stdout.includes(sentinel)); assert.ok(!execution.stderr.includes(sentinel));
  assert.ok((await fs.readFile(path.join(target, 'requests.jsonl'), 'utf8')).includes(sentinel));
  execution = run(argumentsList); assert.equal(execution.status, 1);
  execution = run(['prepare', '--input', fixture, '--out-dir', path.join(directory, 'missing-model')]); assert.equal(execution.status, 1);
  const manifest = JSON.parse(await fs.readFile(path.join(target, 'preparation.json'), 'utf8'));
  const results = path.join(directory, 'results.jsonl'); const proposals = path.join(directory, 'proposals.json');
  await fs.writeFile(results, JSON.stringify(result(manifest.expected[0])) + '\n');
  execution = run(['validate', '--manifest', path.join(target, 'preparation.json'), '--results', results, '--out', proposals]);
  assert.equal(execution.status, 0, execution.stderr); assert.equal(JSON.parse(await fs.readFile(proposals, 'utf8')).state, 'NEEDS_REVIEW');
  const invalid = clone(result(manifest.expected[0])); invalid.response.body.status = 'incomplete';
  await fs.writeFile(results, JSON.stringify(invalid));
  execution = run(['validate', '--manifest', path.join(target, 'preparation.json'), '--results', results, '--out', path.join(directory, 'failed.json')]);
  assert.equal(execution.status, 2);
  await fs.writeFile(results, sentinel);
  execution = run(['validate', '--manifest', path.join(target, 'preparation.json'), '--results', results, '--out', path.join(directory, 'bad.json')]);
  assert.equal(execution.status, 1); assert.ok(!execution.stderr.includes(sentinel));
});
