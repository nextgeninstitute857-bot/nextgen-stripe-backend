import crypto from 'node:crypto';

export const AYLA_QBANK_TAXONOMY_SCHEMA = 'ayla-qbank-facets-v1';
export const AYLA_QBANK_USAGE_STATUSES = Object.freeze(['all', 'unused', 'incorrect', 'marked']);
export const AYLA_QBANK_TAXONOMY_LEVELS = Object.freeze(['system', 'subsystem', 'topic', 'subtopic']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(message, code = 'INVALID_QBANK_SELECTION') {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

export function normalizeAylaQbankUsageStatus(value = 'all') {
  if (typeof value !== 'string') throw invalid('Question status must be a single value', 'INVALID_QBANK_STATUS');
  const status = value.trim().toLowerCase() || 'all';
  if (!AYLA_QBANK_USAGE_STATUSES.includes(status)) throw invalid('Question status must be all, unused, incorrect, or marked', 'INVALID_QBANK_STATUS');
  return status;
}

// Missing paths preserve legacy scalar selection. An explicit empty list means
// no selected content, not all content. Never discard an invalid branch.
export function normalizeAylaQbankSelectionPaths(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 500) throw invalid('selection_paths must be an array of at most 500 paths');
  const paths = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw invalid('Each selection path must be an object');
    const path = {};
    let missing = false;
    for (const level of AYLA_QBANK_TAXONOMY_LEVELS) {
      const key = `${level}_key`;
      const raw = item[key];
      if (raw === undefined || raw === '') { missing = true; continue; }
      if (typeof raw !== 'string' || /\u0000/.test(raw) || raw.trim().length > 240 || !raw.trim()) throw invalid(`Invalid ${key} in selection path`);
      if (missing) throw invalid('A selection path must include every ancestor');
      path[key] = raw.trim();
    }
    if (!path.system_key) throw invalid('A selection path requires system_key');
    if (Object.keys(item).some(key => !AYLA_QBANK_TAXONOMY_LEVELS.some(level => key === `${level}_key`))) throw invalid('Unknown field in selection path');
    return path;
  });
  const unique = [...new Map(paths.map(path => [JSON.stringify(path), path])).values()];
  return unique.filter(path => !unique.some(parent => parent !== path
    && Object.keys(parent).length < Object.keys(path).length
    && Object.entries(parent).every(([key, value]) => path[key] === value)));
}

// The route supplies this history after checking owner, student and exam.
// It must never accept these ID arrays from the request body.
export function normalizeAylaQbankUsageHistory(history, status = 'all') {
  const cleanStatus = normalizeAylaQbankUsageStatus(status);
  if (cleanStatus !== 'all' && (!history || typeof history !== 'object' || Array.isArray(history))) {
    throw invalid('Question history is required for this status', 'QBANK_HISTORY_REQUIRED');
  }
  const result = {};
  for (const key of ['seenQuestionIds', 'incorrectQuestionIds', 'markedQuestionIds']) {
    const rows = history?.[key];
    if (cleanStatus !== 'all' && !Array.isArray(rows)) throw invalid('Complete scoped question history is required', 'QBANK_HISTORY_REQUIRED');
    if (rows !== undefined && (!Array.isArray(rows) || rows.length > 100_000 || rows.some(id => typeof id !== 'string' || !UUID.test(id)))) {
      throw invalid('Invalid scoped question history', 'INVALID_QBANK_HISTORY');
    }
    result[key] = [...new Set((rows || []).map(id => id.toLowerCase()))];
  }
  return result;
}

function cleanLabel(value) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/\u0000/g, '').trim().slice(0, 180) : '';
}

function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20); }

// Input rows are disjoint aggregates of eligible question IDs, produced by
// getContentQbankFacets. Source-derived question-title topics are excluded in
// SQL; no clinical label is inferred from a stem or an opaque topic key here.
export function buildAylaQbankFacetTree(rows = [], { examTrack = '' } = {}) {
  const roots = [];
  const nodes = new Map();
  let total = 0;
  let reviewed = 0;
  let sourceGrouped = 0;
  let unmapped = 0;
  for (const row of rows) {
    const count = Math.max(0, Math.trunc(Number(row.question_count) || 0));
    if (!count) continue;
    total += count;
    const status = row.mapping_status === 'reviewed' ? 'reviewed' : row.mapping_status === 'source_grouping' ? 'source_grouping' : 'unmapped';
    if (status === 'reviewed' && row.subtopic_key) reviewed += count;
    else if (status === 'source_grouping') sourceGrouped += count;
    else unmapped += count;
    let parent = null;
    const selection = {};
    const path = [];
    for (const level of AYLA_QBANK_TAXONOMY_LEVELS) {
      const key = typeof row[`${level}_key`] === 'string' ? row[`${level}_key`] : '';
      if (!key) break;
      selection[`${level}_key`] = key;
      const id = `qbf_${digest([examTrack, selection])}`;
      const label = cleanLabel(row[`${level}_label`]) || (level === 'system' ? 'Unmapped source system' : 'Unmapped source group');
      path.push({ id, label, level, key });
      let node = nodes.get(id);
      if (!node) {
        node = { id, label, level, parent_id: parent?.id || null, path: [...path], selection_path: { ...selection }, question_count: 0,
          mapping_status: status, unmapped_question_count: 0, children: [] };
        nodes.set(id, node);
        (parent ? parent.children : roots).push(node);
      }
      node.question_count += count;
      if (status !== 'reviewed' || !row.subtopic_key) node.unmapped_question_count += count;
      if (node.mapping_status !== status) node.mapping_status = 'mixed';
      parent = node;
    }
  }
  const sort = items => {
    items.sort((a,b)=>a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    for (const item of items) {
      // A parent may contain both reviewed topic rows and source-only rows.
      // Do not expose an incomplete child list: otherwise removing one child
      // would silently drop the unrepresented remainder during path splitting.
      if (item.children.length && item.children.reduce((sum, child)=>sum+child.question_count,0) !== item.question_count) {
        item.children = [];
        item.children_incomplete = true;
      }
      sort(item.children);
    }
  };
  sort(roots);
  return {
    taxonomy_version: `${AYLA_QBANK_TAXONOMY_SCHEMA}:${digest([examTrack, roots])}`,
    question_count: total,
    nodes: roots,
    supported_statuses: [...AYLA_QBANK_USAGE_STATUSES],
    coverage: { reviewed_question_count: reviewed, source_grouped_question_count: sourceGrouped, unmapped_question_count: unmapped,
      deeper_mapping_needed_question_count: total - reviewed },
  };
}

// Each input must cover one disjoint source-exam question pool, with all chosen
// banks for that exam already combined in its COUNT(DISTINCT q.id) query.
// Per-bank counts cannot be deduplicated after question identities are removed.
export function mergeAylaQbankFacets(results = [], { examTrack = '' } = {}) {
  const groups = new Set();
  const byPath = new Map();
  const coverage = { reviewed_question_count: 0, source_grouped_question_count: 0, unmapped_question_count: 0, deeper_mapping_needed_question_count: 0 };
  let total = 0;
  for (const result of results) {
    const sourceExam = result.source_exam_track;
    if (sourceExam && groups.has(sourceExam)) throw invalid('Combine banks within each source exam before merging facets', 'OVERLAPPING_QBANK_FACET_GROUPS');
    if (sourceExam) groups.add(sourceExam);
    total += Number(result.question_count) || 0;
    for (const key of Object.keys(coverage)) coverage[key] += Number(result.coverage?.[key]) || 0;
    const visit = node => {
      const selection = node.selection_path;
      const key = JSON.stringify(selection);
      let aggregate = byPath.get(key);
      if (!aggregate) {
        aggregate = { ...node, id: `qbf_${digest([examTrack, selection])}`, question_count: 0, unmapped_question_count: 0, children: [], path: [] };
        byPath.set(key, aggregate);
      }
      aggregate.question_count += Number(node.question_count) || 0;
      aggregate.unmapped_question_count += Number(node.unmapped_question_count) || 0;
      if (aggregate.mapping_status !== node.mapping_status) aggregate.mapping_status = 'mixed';
      if (node.label.localeCompare(aggregate.label) < 0) aggregate.label = node.label;
      if (node.children_incomplete) aggregate.children_incomplete = true;
      (node.children || []).forEach(visit);
    };
    (result.nodes || []).forEach(visit);
  }
  const roots = [];
  for (const node of byPath.values()) {
    const parentPath = { ...node.selection_path };
    delete parentPath[`${node.level}_key`];
    const parent = byPath.get(JSON.stringify(parentPath));
    node.parent_id = parent?.id || null;
    (parent ? parent.children : roots).push(node);
  }
  const finalize = (items, ancestors = []) => {
    items.sort((a,b)=>a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
    for (const node of items) {
      node.path = [...ancestors, { id: node.id, label: node.label, level: node.level, key: node.selection_path[`${node.level}_key`] }];
      if (node.children.length && node.children.reduce((sum,child)=>sum+child.question_count,0) !== node.question_count) {
        node.children=[];
        node.children_incomplete=true;
      }
      finalize(node.children,node.path);
    }
  };
  finalize(roots);
  return { taxonomy_version: `${AYLA_QBANK_TAXONOMY_SCHEMA}:${digest([examTrack, roots])}`, question_count: total,
    nodes: roots, supported_statuses: [...AYLA_QBANK_USAGE_STATUSES], coverage };
}
