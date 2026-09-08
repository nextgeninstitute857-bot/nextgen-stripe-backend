import crypto from 'node:crypto';
import { normalizeContentTaxonomyExamTrack, normalizeContentTaxonomyKey } from './content-taxonomy-control.js';
import { normalizeAylaNclexVariant } from './aylamed-nclex-variant.js';
import { aylaNclexDiagnosticSystems } from './aylamed-nclex-diagnostic.js';
import { NCLEX_VARIANT_TAXONOMY_KIND, NCLEX_SOURCE_BINDING_FIELDS, nclexTaxonomySourceBinding, sortNclexTaxonomyBindings } from './content-nclex-variant-taxonomy.js';

export const QUESTION_TAXONOMY_REVIEW_VERSION = 'question-taxonomy-review-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const LEVELS = ['system', 'subsystem', 'topic', 'subtopic'];
const SHARED_NCLEX_VARIANTS = ['nclex_pn', 'nclex_rn'];
const sharedNclexSystems = () => aylaNclexDiagnosticSystems('nclex_rn')
  .filter(label => aylaNclexDiagnosticSystems('nclex_pn').includes(label));
const SENTINELS = /^(?:unclassified|unmapped|unknown|undefined|null|none|other|miscellaneous|tbd|n_a|not_applicable|core_concepts)$/i;
const RAW_LABEL = /[?\r\n<>]|\b(?:\d+[- ]year[- ]old|which of the following|patient (?:presents|is|has)|presents (?:to|with)|most (?:likely|appropriate)|choose the|select the)\b/i;
function fail(message, statusCode = 400, details = null) {
  throw Object.assign(new Error(message), { statusCode, details });
}
function uuid(value, field) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(`${field} must be a valid UUID`);
  return value.toLowerCase();
}
function canonical(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const basename = value => String(value || '').split(/[\\/]/).at(-1);
function examScope(value) {
  const exam = normalizeContentTaxonomyExamTrack(value);
  if (!exam) fail('A supported exam_track is required');
  const aliases = {
    'usmle-step-1': ['usmle-step-1', 'usmle_step_1'],
    'usmle-step-2': ['usmle-step-2', 'usmle-step-2-ck', 'usmle_step_2', 'usmle_step_2_ck'],
    'usmle-step-3': ['usmle-step-3', 'usmle_step_3'],
  };
  return { exam, aliases: aliases[exam] || [exam] };
}

export function normalizeReviewedQuestionTaxonomy(taxonomy, allowedSystems = []) {
  if (!taxonomy || typeof taxonomy !== 'object' || Array.isArray(taxonomy)) fail('A complete taxonomy object is required');
  const result = { labels: {} };
  for (const level of LEVELS) {
    const label = taxonomy.labels?.[level];
    const key = taxonomy[`${level}_key`];
    if (typeof label !== 'string' || !label.trim() || label !== label.trim() || label.length > 140
      || RAW_LABEL.test(label) || UUID.test(label) || SHA256.test(label) || /^[\W\d_]+$/.test(label)
      || /^(?:sys(?:tem)?|subject|topic|subtopic|question|source)[_ -]?\d+(?:[_ -]\d+)*$/i.test(label)
      || /\b(?:NGQ|AYLA-Q|question[_ -]?id)[_ -]?\d+/i.test(label)) {
      fail(`${level} must have a concise clinical label, not a question stem or source identifier`);
    }
    const expectedKey = normalizeContentTaxonomyKey(label);
    if (typeof key !== 'string' || key !== expectedKey || SENTINELS.test(key)) {
      fail(`${level}_key must match its clinical label using lowercase underscore-separated words`);
    }
    result[`${level}_key`] = key;
    result.labels[level] = label;
  }
  if (!allowedSystems.includes(result.labels.system)) fail('system label must exactly match an allowed exam system');
  return result;
}

export function normalizeQuestionTaxonomyReviewManifest(input, allowedSystems) {
  const { exam } = examScope(input?.exam_track);
  const reviewId = uuid(input?.review_id, 'review_id');
  if (!Array.isArray(input?.items) || input.items.length < 1 || input.items.length > 100) fail('Provide between 1 and 100 explicitly reviewed question items');
  const seen = new Set();
  const items = input.items.map(item => {
    const questionId = uuid(item?.question_id, 'question_id');
    if (seen.has(questionId)) fail('Duplicate question_id in review batch');
    seen.add(questionId);
    if (typeof item.expected_evidence_fingerprint !== 'string' || !SHA256.test(item.expected_evidence_fingerprint)) fail('Each item requires its exported expected_evidence_fingerprint');
    if (typeof item.reason !== 'string' || item.reason.trim().length < 10 || item.reason.length > 2000) fail('Each item requires a review reason between 10 and 2000 characters');
    const revision = item.expected_override_revision;
    if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) fail('expected_override_revision must be a positive integer when supplied');
    const variant = normalizeAylaNclexVariant(item.nclex_variant);
    const shared = item.nclex_variants !== undefined;
    if (shared && (exam !== 'nclex' || item.nclex_variant != null || !Array.isArray(item.nclex_variants)
      || item.nclex_variants.length !== 2 || [...item.nclex_variants].sort().join('|') !== SHARED_NCLEX_VARIANTS.join('|'))) {
      fail('Shared NCLEX review requires exactly nclex_rn and nclex_pn, without a single nclex_variant');
    }
    if (exam === 'nclex' && !shared && (!variant || variant !== item.nclex_variant)) fail('NCLEX items require their exact exported nclex_variant');
    if (exam !== 'nclex' && item.nclex_variant != null) fail('nclex_variant is only valid for NCLEX questions');
    return {
      question_id: questionId,
      expected_evidence_fingerprint: item.expected_evidence_fingerprint,
      ...(revision === undefined ? {} : { expected_override_revision: revision }),
      ...(exam === 'nclex' ? shared ? { nclex_variants: [...SHARED_NCLEX_VARIANTS] } : { nclex_variant: variant } : {}),
      taxonomy: item.taxonomy?.kind === NCLEX_VARIANT_TAXONOMY_KIND
        ? normalizeNclexVariantPaths(item.taxonomy, exam === 'nclex' && shared)
        : normalizeReviewedQuestionTaxonomy(item.taxonomy, exam === 'nclex' ? shared ? sharedNclexSystems() : aylaNclexDiagnosticSystems(variant) : allowedSystems),
      reason: item.reason.trim(),
    };
  }).sort((a, b) => a.question_id.localeCompare(b.question_id));
  return { version: QUESTION_TAXONOMY_REVIEW_VERSION, exam_track: exam, review_id: reviewId, items };
}

function normalizeNclexVariantPaths(taxonomy, shared) {
  if (!shared) fail('Variant-specific paths require explicit shared NCLEX review');
  if (Object.keys(taxonomy.paths || {}).sort().join('|') !== SHARED_NCLEX_VARIANTS.join('|')) fail('Provide exactly one reviewed path for each NCLEX variant');
  const paths = Object.fromEntries(SHARED_NCLEX_VARIANTS.map(variant => [variant, normalizeReviewedQuestionTaxonomy(taxonomy.paths[variant], aylaNclexDiagnosticSystems(variant))]));
  if (!Array.isArray(taxonomy.source_bindings) || taxonomy.source_bindings.length < 2 || taxonomy.source_bindings.length > 100) fail('Provide the exported source bindings for both variants');
  const collections = new Map(), seen = new Set();
  const bindings = taxonomy.source_bindings.map(binding => {
    if (!SHARED_NCLEX_VARIANTS.includes(binding?.variant) || Object.keys(binding).sort().join('|') !== ['variant', ...NCLEX_SOURCE_BINDING_FIELDS].sort().join('|')) fail('Each source binding must exactly match the exported provenance fields');
    for (const key of NCLEX_SOURCE_BINDING_FIELDS) if (typeof binding[key] !== 'string' || binding[key].length > 2000) fail('Source binding values must match their exported strings');
    uuid(binding.collection_id, 'source binding collection_id');
    const normalized = nclexTaxonomySourceBinding(binding, binding.variant);
    if (normalized.source_file !== binding.source_file) fail('Source bindings use the exported filename without its private directory');
    const previous = collections.get(binding.collection_id);
    if (previous && previous !== binding.variant) fail('A source collection cannot represent both NCLEX variants');
    collections.set(binding.collection_id, binding.variant);
    const key = digest(normalized); if (seen.has(key)) fail('Duplicate source binding'); seen.add(key);
    return normalized;
  });
  if (new Set(collections.values()).size !== 2) fail('Distinct source collections for both NCLEX variants are required');
  return { kind: NCLEX_VARIANT_TAXONOMY_KIND, paths, source_bindings: sortNclexTaxonomyBindings(bindings) };
}

const REVIEW_SCOPE = `EXISTS (SELECT 1 FROM content_source_aliases scope_alias
  JOIN content_collections scope_collection ON scope_collection.id=scope_alias.collection_id
  WHERE scope_alias.question_id=q.id AND (scope_collection.destinations ? 'aylamed_qbank'
    OR EXISTS (SELECT 1 FROM content_collection_destinations scope_destination
      WHERE scope_destination.collection_id=scope_collection.id AND scope_destination.destination='aylamed_qbank')))`;
// One SELECT snapshots full evidence and review state together. Provider tokens,
// signed media URLs and complete imported source_data are never exported.
const EVIDENCE_SELECT = `SELECT q.*,to_jsonb(o) AS review_override,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('answer_id',answer_id,'text_html',text_html) ORDER BY answer_id)
    FROM content_answers WHERE question_id=q.id),'[]'::jsonb) AS review_answers,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('source_namespace',a.source_namespace,
      'source_item_id',a.source_item_id,'collection_id',a.collection_id,
      'collection_title',c.title,'collection_key',c.collection_key,'source_provider',c.source_provider,'source_profile',c.source_profile,
      'source_file',a.source_data->>'import_source_file',
      'qbank_registered',(c.destinations ? 'aylamed_qbank' OR EXISTS (SELECT 1 FROM content_collection_destinations d WHERE d.collection_id=c.id AND d.destination='aylamed_qbank')))
      ORDER BY a.source_namespace,a.collection_id,a.source_item_id,a.id)
    FROM content_source_aliases a LEFT JOIN content_collections c ON c.id=a.collection_id WHERE a.question_id=q.id),'[]'::jsonb) AS review_sources
  FROM content_questions q LEFT JOIN content_question_taxonomy_overrides o ON o.question_id=q.id`;

export function questionTaxonomyEvidenceFingerprint(row) {
  return digest({ version: QUESTION_TAXONOMY_REVIEW_VERSION, question: row });
}
export function questionTaxonomyVariantScope(row, allowedSystems = []) {
  if (examScope(row.exam_track).exam !== 'nclex') return { allowed_systems: allowedSystems, nclex_variant: null, variant_evidence: [], classification_blocked_reason: null };
  const evidence = [];
  const variants = new Set();
  const hints = text => {
    const clean = String(text || '').toLowerCase().replace(/[_-]+/g, ' ');
    return [/(?:^|\W)(?:rn|registered nurs(?:e|ing))(?:$|\W)/.test(clean) ? 'nclex_rn' : '',
      /(?:^|\W)(?:pn|lpn|lvn|practical nurs(?:e|ing))(?:$|\W)/.test(clean) ? 'nclex_pn' : ''].filter(Boolean);
  };
  let missing = false;
  let ambiguousAlias = false;
  const collectionVariants = new Map();
  const aliases = (row.review_sources || []).filter(source => source.qbank_registered === true);
  if (!aliases.length) missing = true;
  for (const source of aliases) {
    const found = new Set(hints([source.source_namespace, source.collection_title, source.collection_key, source.source_provider, source.source_profile, basename(source.source_file)].filter(Boolean).join(' ')));
    if (!found.size) missing = true;
    // A shared question needs distinct, individually unambiguous RN and PN
    // collections. A single "RN and PN" label is not evidence for either one.
    if (found.size !== 1 || !source.collection_id) ambiguousAlias = true;
    if (found.size === 1 && source.collection_id) {
      const variant = [...found][0], previous = collectionVariants.get(source.collection_id);
      if (previous && previous !== variant) ambiguousAlias = true;
      collectionVariants.set(source.collection_id, variant);
    }
    for (const variant of found) { variants.add(variant); evidence.push({ source_namespace: source.source_namespace, collection_id: source.collection_id, variant }); }
  }
  const data = row.source_data || {};
  for (const key of ['nclex_variant', 'nclexVariant', 'exam_variant', 'examVariant', 'source_exam_track_hint']) {
    if (!data[key]) continue;
    const direct = normalizeAylaNclexVariant(data[key]);
    const found = direct ? [direct] : hints(data[key]);
    if (!found.length && key !== 'source_exam_track_hint') missing = true;
    if (found.length > 1) ambiguousAlias = true;
    for (const variant of found) { variants.add(variant); evidence.push({ field: key, variant }); }
  }
  const blocked = variants.size > 1 ? 'nclex_variant_conflict' : missing || variants.size !== 1 ? 'nclex_variant_missing' : null;
  const variant = blocked ? null : [...variants][0];
  const sharedAllowed = !missing && !ambiguousAlias && variants.size === 2
    && new Set(collectionVariants.values()).size === 2;
  // Keep the single-variant guard unchanged. Shared review is an explicit,
  // separately validated operation using only categories common to both plans.
  return { allowed_systems: variant ? aylaNclexDiagnosticSystems(variant) : [], nclex_variant: variant, variant_evidence: evidence, classification_blocked_reason: blocked,
    shared_classification_allowed: sharedAllowed, shared_nclex_variants: sharedAllowed ? [...SHARED_NCLEX_VARIANTS] : [],
    shared_allowed_systems: sharedAllowed ? sharedNclexSystems() : [],
    shared_variant_allowed_systems: sharedAllowed ? Object.fromEntries(SHARED_NCLEX_VARIANTS.map(v => [v, aylaNclexDiagnosticSystems(v)])) : {},
    shared_source_bindings: sharedAllowed ? sortNclexTaxonomyBindings(aliases.map(source => nclexTaxonomySourceBinding(source, collectionVariants.get(source.collection_id)))) : [] };
}

function evidenceDto(row, allowedSystems) {
  const source = row.source_data || {};
  const nativeLabels = Object.fromEntries(['sysName', 'subName', 'systemName', 'subjectName', 'system', 'subject', 'topic', 'subtopic']
    .filter(key => typeof source[key] === 'string').map(key => [key, source[key].slice(0, 500)]));
  return {
    id: row.id, student_qid: row.student_qid, title: row.title, exam_track: row.exam_track, status: row.status,
    question_html: row.question_html, explanation_html: row.explanation_html,
    correct_answer_id: row.correct_answer_id, answers: row.review_answers,
    native: { system_key: row.system_key, subject_key: row.subject_key, labels: nativeLabels },
    sources: row.review_sources.map(source => ({ ...source, source_file: basename(source.source_file) || null })), taxonomy: row.taxonomy || {},
    override: row.review_override ? { id: row.review_override.id, status: row.review_override.status, revision: row.review_override.revision } : null,
    evidence_fingerprint: questionTaxonomyEvidenceFingerprint(row),
    ...questionTaxonomyVariantScope(row, allowedSystems),
  };
}

export async function exportQuestionTaxonomyReviewPage(client, { examTrack, allowedSystems = [], limit = 100, after = '', sourceNamespace = '', questionIds } = {}) {
  const { exam, aliases } = examScope(examTrack);
  const pageSize = Number(limit);
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) fail('limit must be an integer between 1 and 100');
  const cursor = after ? uuid(after, 'after') : null;
  let requestedIds = null;
  if (questionIds !== undefined) {
    if (!Array.isArray(questionIds) || questionIds.length < 1 || questionIds.length > 100) fail('question_ids must contain between 1 and 100 UUIDs');
    requestedIds = [...new Set(questionIds.map(id => uuid(id, 'question_ids')))];
    if (cursor) fail('question_ids cannot be combined with after');
    if (requestedIds.length > pageSize) fail('limit must include every explicitly requested question');
  }
  if (typeof sourceNamespace !== 'string' || sourceNamespace.length > 160) fail('Invalid source_namespace');
  const result = await client.query(`${EVIDENCE_SELECT}
    WHERE q.exam_track=ANY($1::text[]) AND ${REVIEW_SCOPE}
      AND ($2::uuid IS NULL OR q.id>$2::uuid)
      AND ($3='' OR EXISTS (SELECT 1 FROM content_source_aliases a WHERE a.question_id=q.id AND a.source_namespace=$3))
      AND ($5::uuid[] IS NULL OR q.id=ANY($5::uuid[]))
    ORDER BY q.id LIMIT $4`, [aliases, cursor, sourceNamespace, pageSize + 1, requestedIds]);
  if (requestedIds && result.rows.length !== requestedIds.length) fail('A requested question does not exist in this exam and source QBank scope', 404);
  const rows = result.rows.slice(0, pageSize);
  const hasMore = result.rows.length > pageSize;
  return { evidence_version: QUESTION_TAXONOMY_REVIEW_VERSION, exam_track: exam, allowed_systems: exam === 'nclex' ? [] : allowedSystems,
    count: rows.length, has_more: hasMore, next_after: hasMore ? rows.at(-1).id : null,
    scope: 'Registered AylaMed QBank questions; publication and scoring remain unchanged', questions: rows.map(row => evidenceDto(row, allowedSystems)) };
}

function previewRows(manifest, questions) {
  const byId = new Map(questions.map(row => [row.id, row]));
  return manifest.items.map(item => {
    const row = byId.get(item.question_id);
    if (!row) fail('A requested question does not exist in this exam QBank scope', 404, { question_id: item.question_id });
    if (manifest.exam_track === 'nclex') {
      const variant = questionTaxonomyVariantScope(row);
      if (item.nclex_variants) {
        if (!variant.shared_classification_allowed) fail('Shared NCLEX review requires separate, unambiguous RN and PN source collections', 422, { question_id: item.question_id });
        if (item.taxonomy.kind === NCLEX_VARIANT_TAXONOMY_KIND) {
          if (digest(item.taxonomy.source_bindings) !== digest(variant.shared_source_bindings)) fail('Variant path bindings must exactly match all exported RN and PN source provenance', 409, { question_id: item.question_id });
        } else normalizeReviewedQuestionTaxonomy(item.taxonomy, variant.shared_allowed_systems);
      } else {
        if (variant.classification_blocked_reason) fail('NCLEX source variant is missing or conflicting; resolve source provenance before classification', 422, { question_id: item.question_id, code: variant.classification_blocked_reason });
        if (variant.nclex_variant !== item.nclex_variant) fail('NCLEX review variant does not match the question source', 409, { question_id: item.question_id });
        normalizeReviewedQuestionTaxonomy(item.taxonomy, variant.allowed_systems);
      }
    }
    if (questionTaxonomyEvidenceFingerprint(row) !== item.expected_evidence_fingerprint) fail('Question evidence or taxonomy changed after export; export and review it again', 409, { question_id: item.question_id });
    const override = row.review_override;
    if (override?.status === 'active' && item.expected_override_revision === undefined) fail('Replacing an active reviewed override requires its explicit expected_override_revision', 409, { question_id: item.question_id });
    if (item.expected_override_revision !== undefined && Number(override?.revision) !== item.expected_override_revision) fail('The question override revision changed; export and review it again', 409, { question_id: item.question_id });
    const existingKeys = row.taxonomy?.kind === NCLEX_VARIANT_TAXONOMY_KIND ? ['kind', 'paths', 'source_bindings'] : [...LEVELS.map(level => `${level}_key`), 'labels'];
    const existingTaxonomy = Object.fromEntries(existingKeys.map(key => [key, row.taxonomy?.[key]]));
    const unchanged = override?.status === 'active' && row.taxonomy?.source === 'question_override'
      && row.taxonomy?.override_id === override.id && row.taxonomy?.review_status === 'approved'
      && digest(existingTaxonomy) === digest(item.taxonomy) && digest(override.taxonomy) === digest(item.taxonomy);
    return { question_id: item.question_id, before_taxonomy: row.taxonomy || {}, after_taxonomy: item.taxonomy,
      action: unchanged ? 'unchanged' : 'update', override_revision: override?.revision || null,
      review_reason: item.reason, evidence_fingerprint: item.expected_evidence_fingerprint };
  });
}

export async function reviewQuestionTaxonomyBatch(client, input, { allowedSystems = [], actorId = '' } = {}) {
  const manifest = normalizeQuestionTaxonomyReviewManifest(input, allowedSystems);
  const fingerprint = digest(manifest);
  const apply = input.apply === true;
  if (input.apply !== undefined && typeof input.apply !== 'boolean') fail('apply must be a boolean');
  if (apply && input.expected_fingerprint !== fingerprint) fail('The reviewed batch changed after dry-run; validate the exact batch again', 409);
  const { aliases } = examScope(manifest.exam_track);
  let transaction = false;
  try {
    if (apply) {
      if (!String(actorId).trim()) fail('Authenticated review actor is required', 403);
      await client.query('BEGIN'); transaction = true;
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='15s'");
      const inserted = await client.query(`INSERT INTO content_question_taxonomy_imports
        (id,exam_track,payload_fingerprint,created_by,review_manifest) VALUES ($1,$2,$3,$4,$5::jsonb)
        ON CONFLICT (id) DO NOTHING RETURNING id`, [manifest.review_id, manifest.exam_track, fingerprint, actorId, JSON.stringify(manifest)]);
      if (!inserted.rows.length) {
        const previous = (await client.query('SELECT * FROM content_question_taxonomy_imports WHERE id=$1 FOR UPDATE', [manifest.review_id])).rows[0];
        if (!previous || previous.payload_fingerprint !== fingerprint || previous.exam_track !== manifest.exam_track) fail('review_id was already used for a different reviewed batch', 409);
        if (!previous.result) fail('This review batch has not completed; retry its original request', 409);
        await client.query('COMMIT'); transaction = false;
        return { ...previous.result, replayed: true };
      }
      // Imports lock collections before questions. Plan the parent set, freeze
      // its metadata/registrations first, then lock children and recheck that
      // no alias moved between planning and lock acquisition.
      const questionIds = manifest.items.map(item => item.question_id);
      const collectionQuery = 'SELECT DISTINCT collection_id FROM content_source_aliases WHERE question_id=ANY($1::uuid[]) AND collection_id IS NOT NULL ORDER BY collection_id';
      const collectionIds = (await client.query(collectionQuery, [questionIds])).rows.map(row => row.collection_id);
      await client.query('SELECT id FROM content_collections WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [collectionIds]);
      await client.query('SELECT collection_id,destination,destination_scope FROM content_collection_destinations WHERE collection_id=ANY($1::uuid[]) ORDER BY collection_id,destination,destination_scope FOR SHARE', [collectionIds]);
      await client.query('SELECT id FROM content_questions WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [manifest.items.map(item => item.question_id)]);
      await client.query('SELECT question_id,answer_id FROM content_answers WHERE question_id=ANY($1::uuid[]) ORDER BY question_id,answer_id FOR SHARE', [manifest.items.map(item => item.question_id)]);
      await client.query('SELECT id FROM content_source_aliases WHERE question_id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [manifest.items.map(item => item.question_id)]);
      await client.query('SELECT id FROM content_question_taxonomy_overrides WHERE question_id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [manifest.items.map(item => item.question_id)]);
      const lockedCollectionIds = (await client.query(collectionQuery, [questionIds])).rows.map(row => row.collection_id);
      if (digest(collectionIds) !== digest(lockedCollectionIds)) fail('Question source collections changed during review; refresh the evidence', 409);
    }
    const questions = (await client.query(`${EVIDENCE_SELECT} WHERE q.exam_track=ANY($1::text[])
      AND q.id=ANY($2::uuid[]) AND ${REVIEW_SCOPE} ORDER BY q.id`, [aliases, manifest.items.map(item => item.question_id)])).rows;
    const rows = previewRows(manifest, questions);
    const response = { valid: true, dry_run: !apply, applied: apply, replayed: false, review_id: manifest.review_id,
      exam_track: manifest.exam_track, fingerprint, count: rows.length,
      updated_count: rows.filter(row => row.action === 'update').length,
      unchanged_count: rows.filter(row => row.action === 'unchanged').length, rows };
    if (!apply) return response;
    const byId = new Map(questions.map(row => [row.id, row]));
    for (const [index, item] of manifest.items.entries()) {
      if (rows[index].action === 'unchanged') continue;
      const question = byId.get(item.question_id);
      const previous = question.review_override;
      const overrideId = previous?.id || crypto.randomUUID();
      const override = (await client.query(`INSERT INTO content_question_taxonomy_overrides
        (id,question_id,exam_track,taxonomy,previous_taxonomy,status,reason,created_by,updated_by,revision)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,'active',$6,$7,$7,1)
        ON CONFLICT (question_id) DO UPDATE SET taxonomy=EXCLUDED.taxonomy,status='active',
          previous_taxonomy=CASE WHEN content_question_taxonomy_overrides.status='active'
            THEN content_question_taxonomy_overrides.previous_taxonomy ELSE EXCLUDED.previous_taxonomy END,
          reason=EXCLUDED.reason,updated_by=EXCLUDED.updated_by,
          revision=content_question_taxonomy_overrides.revision+1,updated_at=NOW() RETURNING *`,
      [overrideId, question.id, question.exam_track, JSON.stringify(item.taxonomy), JSON.stringify(question.taxonomy || {}), item.reason, actorId])).rows[0];
      const storedTaxonomy = { ...item.taxonomy, source: 'question_override', override_id: overrideId, review_status: 'approved', review_id: manifest.review_id };
      if (item.taxonomy.kind === NCLEX_VARIANT_TAXONOMY_KIND) storedTaxonomy.fallback_taxonomy = override.previous_taxonomy || {};
      await client.query('UPDATE content_questions SET taxonomy=$2::jsonb,updated_at=NOW() WHERE id=$1', [question.id, JSON.stringify(storedTaxonomy)]);
      await client.query(`INSERT INTO content_taxonomy_audit_events
        (id,question_id,exam_track,action,before_state,after_state,note,actor_id)
        VALUES ($1,$2,$3,'question_review_batch_applied',$4::jsonb,$5::jsonb,$6,$7)`,
      [crypto.randomUUID(), question.id, question.exam_track,
        JSON.stringify({ question_taxonomy: question.taxonomy || {}, override: previous }),
        JSON.stringify({ question_taxonomy: storedTaxonomy, override, review_id: manifest.review_id, evidence_fingerprint: item.expected_evidence_fingerprint }), item.reason, actorId]);
      rows[index].after_taxonomy = storedTaxonomy;
      rows[index].override_revision = override.revision;
    }
    await client.query('UPDATE content_question_taxonomy_imports SET result=$2::jsonb WHERE id=$1', [manifest.review_id, JSON.stringify(response)]);
    await client.query('COMMIT'); transaction = false;
    return response;
  } catch (error) {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
    if (['40001', '40P01', '55P03', '57014'].includes(error.code)) fail('A concurrent content update or timeout interrupted this review; retry the original batch or refresh its evidence', 409);
    throw error;
  }
}
