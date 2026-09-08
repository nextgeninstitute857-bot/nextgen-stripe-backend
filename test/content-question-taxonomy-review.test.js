import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewedQuestionTaxonomy, normalizeQuestionTaxonomyReviewManifest, questionTaxonomyEvidenceFingerprint, questionTaxonomyVariantScope } from '../lib/content-question-taxonomy-review.js';
import { NCLEX_VARIANT_TAXONOMY_KIND, nclexTaxonomySourceBinding } from '../lib/content-nclex-variant-taxonomy.js';
const taxonomy = () => ({ system_key: 'cardiovascular', subsystem_key: 'valvular_disease', topic_key: 'aortic_stenosis', subtopic_key: 'diagnosis', labels: { system: 'Cardiovascular', subsystem: 'Valvular disease', topic: 'Aortic stenosis', subtopic: 'Diagnosis' } });
const item = () => ({ question_id: '00000000-0000-4000-8000-000000000001', expected_evidence_fingerprint: 'a'.repeat(64), taxonomy: taxonomy(), reason: 'Reviewed the complete question and explanation.' });
const manifest = () => ({ exam_track: 'usmle_step_1', review_id: '00000000-0000-4000-8000-000000000002', items: [item()] });

test('reviewed taxonomy requires exact exam systems, keys and four clinical labels', () => {
  assert.deepEqual(normalizeReviewedQuestionTaxonomy(taxonomy(), ['Cardiovascular']), taxonomy());
  for (const label of ['unclassified', 'Unknown', 'other', 'core concepts', 'source123', '12345', 'Which of the following is most likely?', 'A 60-year-old patient presents with chest pain', '<b>Diagnosis</b>', 'a'.repeat(141)]) {
    const t = taxonomy(); t.labels.topic = label; t.topic_key = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    assert.throws(() => normalizeReviewedQuestionTaxonomy(t, ['Cardiovascular']), /clinical|label|stem|identifier/);
  }
  const missing = taxonomy(); delete missing.labels.subtopic;
  assert.throws(() => normalizeReviewedQuestionTaxonomy(missing, ['Cardiovascular']), /subtopic/);
  assert.throws(() => normalizeReviewedQuestionTaxonomy(taxonomy(), ['Internal Medicine']), /allowed exam/);
  const mismatched = taxonomy(); mismatched.topic_key = 'patient_stem';
  assert.throws(() => normalizeReviewedQuestionTaxonomy(mismatched, ['Cardiovascular']), /topic_key/);
  const clinical = taxonomy(); clinical.labels.topic = 'Gene Mapping'; clinical.topic_key = 'gene_mapping';
  assert.equal(normalizeReviewedQuestionTaxonomy(clinical, ['Cardiovascular']).labels.topic, 'Gene Mapping');
});

test('manifest validation bounds explicit identities and requires recorded evidence and review', () => {
  assert.equal(normalizeQuestionTaxonomyReviewManifest(manifest(), ['Cardiovascular']).exam_track, 'usmle-step-1');
  for (const patch of [{ items: [] }, { items: Array(101).fill(item()) }, { items: [item(), item()] }, { exam_track: 'other-exam' }, { review_id: 'invented' }]) {
    assert.throws(() => normalizeQuestionTaxonomyReviewManifest({ ...manifest(), ...patch }, ['Cardiovascular']));
  }
  for (const patch of [{ expected_evidence_fingerprint: '' }, { reason: '' }, { expected_override_revision: null }, { expected_override_revision: '1' }]) {
    assert.throws(() => normalizeQuestionTaxonomyReviewManifest({ ...manifest(), items: [{ ...item(), ...patch }] }, ['Cardiovascular']));
  }
});

test('evidence fingerprints bind content, answers, aliases and override state independent of object order', () => {
  const row = { id: 'q', question_html: 'Synthetic question', review_answers: [{ answer_id: 1, text_html: 'A' }], review_sources: [{ source_item_id: 'native' }], review_override: { revision: 1 } };
  const hash = questionTaxonomyEvidenceFingerprint(row);
  assert.equal(hash, questionTaxonomyEvidenceFingerprint(Object.fromEntries(Object.entries(row).reverse())));
  for (const patch of [{ question_html: 'Changed' }, { review_answers: [] }, { review_sources: [] }, { review_override: { revision: 2 } }]) assert.notEqual(questionTaxonomyEvidenceFingerprint({ ...row, ...patch }), hash);
});

test('NCLEX variant evidence comes from every source alias and cannot default ambiguous questions', () => {
  const source = (name) => ({ qbank_registered: true, collection_title: name, source_namespace: name, collection_id: 'fixture' });
  const scope = (sources, data = {}) => questionTaxonomyVariantScope({ exam_track: 'nclex', review_sources: sources, source_data: data });
  assert.equal(scope([source('UWorld NCLEX-RN')]).nclex_variant, 'nclex_rn');
  assert.ok(scope([source('UWorld NCLEX-PN')]).allowed_systems.includes('Coordinated Care'));
  assert.ok(scope([source('UWorld NCLEX-RN')]).allowed_systems.includes('Pharmacological and Parenteral Therapies'));
  assert.equal(scope([source('NCLEX RN and PN')]).classification_blocked_reason, 'nclex_variant_conflict');
  assert.equal(scope([source('NCLEX RN'), source('NCLEX PN')]).classification_blocked_reason, 'nclex_variant_conflict');
  assert.equal(scope([source('NCLEX RN'), source('Generic NCLEX')]).classification_blocked_reason, 'nclex_variant_missing');
  assert.equal(scope([source('NCLEX RN')], { nclex_variant: 'nclex_pn' }).classification_blocked_reason, 'nclex_variant_conflict');
  assert.equal(scope([source('NCLEX RN')], { nclex_variant: 'unverified' }).classification_blocked_reason, 'nclex_variant_missing');
  assert.deepEqual(scope([source('Generic NCLEX')]).allowed_systems, []);
});

test('shared NCLEX eligibility requires independently identified RN and PN collections', () => {
  const source = (title, collection_id) => ({ collection_title: title, collection_id, qbank_registered: true });
  const rn = source('NCLEX RN', 'rn-bank'), pn = source('NCLEX PN', 'pn-bank');
  const scope = (sources, data = {}) => questionTaxonomyVariantScope({ exam_track: 'nclex', review_sources: sources, source_data: data });
  const shared = scope([rn, pn]);
  assert.equal(shared.shared_classification_allowed, true);
  assert.deepEqual(shared.shared_nclex_variants, ['nclex_pn', 'nclex_rn']);
  assert.equal(shared.shared_allowed_systems.length, 6);
  assert.ok(shared.shared_allowed_systems.includes('Physiological Adaptation'));
  for (const label of ['Management of Care', 'Coordinated Care', 'Pharmacological Therapies', 'Pharmacological and Parenteral Therapies']) assert.ok(!shared.shared_allowed_systems.includes(label));
  assert.equal(shared.nclex_variant, null); assert.equal(shared.classification_blocked_reason, 'nclex_variant_conflict');
  for (const [sources, data] of [
    [[rn], {}], [[source('NCLEX RN and PN', 'mixed')], {}], [[rn, { ...pn, collection_id: 'rn-bank' }], {}],
    [[rn, { ...pn, qbank_registered: false }], {}], [[rn, pn, source('NCLEX unspecified', 'unknown')], {}],
    [[rn, { ...pn, collection_id: null }], {}], [[rn, pn], { nclex_variant: 'unknown' }],
    [[rn, pn], { exam_variant: 'NCLEX RN and PN' }],
  ]) {
    const result = scope(sources, data); assert.equal(result.shared_classification_allowed, false); assert.deepEqual(result.shared_allowed_systems, []);
  }
  assert.equal(scope([rn, pn], { nclex_variant: 'nclex_rn' }).shared_classification_allowed, true);
});

test('shared manifests explicitly bind both variants and reject variant-specific categories', () => {
  const common = { ...taxonomy(), system_key: 'physiological_adaptation', labels: { ...taxonomy().labels, system: 'Physiological Adaptation' } };
  const sharedItem = { ...item(), taxonomy: common, nclex_variants: ['nclex_rn', 'nclex_pn'] };
  const make = patch => ({ ...manifest(), exam_track: 'nclex', items: [{ ...sharedItem, ...patch }] });
  const normalized = normalizeQuestionTaxonomyReviewManifest(make({}), []);
  assert.deepEqual(normalized.items[0].nclex_variants, ['nclex_pn', 'nclex_rn']); assert.equal(normalized.items[0].nclex_variant, undefined);
  for (const patch of [{ nclex_variants: null }, { nclex_variants: [] }, { nclex_variants: ['nclex_rn'] }, { nclex_variants: ['nclex_rn', 'nclex_rn'] }, { nclex_variants: ['RN', 'PN'] }, { nclex_variant: 'nclex_rn' }]) assert.throws(() => normalizeQuestionTaxonomyReviewManifest(make(patch), []));
  for (const system of ['Management of Care', 'Coordinated Care', 'Pharmacological Therapies', 'Pharmacological and Parenteral Therapies']) {
    const t = { ...common, system_key: system.toLowerCase().replace(/ /g, '_'), labels: { ...common.labels, system } };
    assert.throws(() => normalizeQuestionTaxonomyReviewManifest(make({ taxonomy: t }), []), /allowed exam system/);
  }
  assert.throws(() => normalizeQuestionTaxonomyReviewManifest({ ...make({}), exam_track: 'usmle_step_1' }, ['Physiological Adaptation']), /Shared NCLEX/);
});

test('variant-specific manifests require both complete exam-correct paths and exact source bindings', () => {
  const path = system => ({ ...taxonomy(), system_key: system.toLowerCase().replace(/ /g, '_'), labels: { ...taxonomy().labels, system } });
  const rn = nclexTaxonomySourceBinding({ collection_id: '00000000-0000-4000-8000-000000000010', collection_title: 'NCLEX RN', source_namespace: 'rn' }, 'nclex_rn');
  const pn = nclexTaxonomySourceBinding({ collection_id: '00000000-0000-4000-8000-000000000011', collection_title: 'NCLEX PN', source_namespace: 'pn' }, 'nclex_pn');
  const make = () => ({ ...manifest(), exam_track: 'nclex', items: [{ ...item(), nclex_variants: ['nclex_rn', 'nclex_pn'], taxonomy: {
    kind: NCLEX_VARIANT_TAXONOMY_KIND, paths: { nclex_rn: path('Management of Care'), nclex_pn: path('Coordinated Care') }, source_bindings: [rn, pn],
  } }] });
  const normalized = normalizeQuestionTaxonomyReviewManifest(make(), []);
  assert.deepEqual(normalizeQuestionTaxonomyReviewManifest(normalized, []), normalized);
  for (const mutate of [
    m => delete m.items[0].taxonomy.paths.nclex_pn,
    m => { m.items[0].taxonomy.paths.nclex_pn = path('Management of Care'); },
    m => delete m.items[0].taxonomy.paths.nclex_rn.labels.subtopic,
    m => { m.items[0].taxonomy.source_bindings = [rn]; },
    m => { m.items[0].taxonomy.source_bindings = [rn, { ...pn, collection_id: rn.collection_id }]; },
    m => { m.items[0].taxonomy.source_bindings = [rn, pn, rn]; },
    m => { m.items[0].taxonomy.source_bindings[0] = { ...rn, unreviewed: 'extra' }; },
    m => { m.items[0].taxonomy.source_bindings[0] = { ...rn, source_file: 'C:\\private\\rn.json' }; },
    m => { delete m.items[0].nclex_variants; m.items[0].nclex_variant = 'nclex_rn'; },
    m => { m.exam_track = 'plab'; },
  ]) { const m = make(); mutate(m); assert.throws(() => normalizeQuestionTaxonomyReviewManifest(m, [])); }
});
