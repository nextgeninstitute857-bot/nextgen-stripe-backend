import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReviewedQuestionTaxonomy, normalizeQuestionTaxonomyReviewManifest, questionTaxonomyEvidenceFingerprint, questionTaxonomyVariantScope } from '../lib/content-question-taxonomy-review.js';
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
