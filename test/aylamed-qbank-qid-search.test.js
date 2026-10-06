import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAylaQbankFilters, normalizeAylaQbankQids } from '../lib/aylamed-qbank.js';
import { contentQbankFacetQuery, contentQbankQuestionsQuery } from '../lib/content-registry-postgres.js';

const highestPlaceholder = (sql) => Math.max(...(sql.match(/\$(\d+)/g) || []).map((token) => Number(token.slice(1))));

test('QIDs typed with commas, spaces or new lines become a clean unique list', () => {
  assert.deepEqual(normalizeAylaQbankQids('1234, 5678\n1234  NGQ-00000012;'), ['1234', '5678', 'NGQ-00000012']);
  assert.deepEqual(normalizeAylaQbankQids(['  99 ', '', 99]), ['99']);
  assert.throws(() => normalizeAylaQbankQids(Array.from({ length: 501 }, (_, i) => String(i))), /500 QIDs/);
});

test('filters keep QIDs only when some were given', () => {
  assert.deepEqual(normalizeAylaQbankFilters({ qids: '11 22' }).qids, ['11', '22']);
  assert.equal(normalizeAylaQbankFilters({ qids: '  ' }).qids, undefined);
  assert.equal(normalizeAylaQbankFilters({}).qids, undefined);
});

test('count and session queries match the bank QID or the NGQ number', () => {
  const count = contentQbankFacetQuery({ examTrack: 'mccqe', filters: { qids: '1234' } });
  assert.deepEqual(count.values.at(-1), ['1234']);
  assert.equal(highestPlaceholder(count.sql), count.values.length);
  assert.match(count.sql, /q\.student_qid=ANY/);
  assert.match(count.sql, /qid_alias\.source_item_id=ANY/);

  const session = contentQbankQuestionsQuery({ examTrack: 'mccqe', qids: ['1234', 'NGQ-00000012'] });
  assert.deepEqual(session.values.at(-1), ['1234', 'NGQ-00000012']);
  assert.equal(highestPlaceholder(session.sql), session.values.length);

  const unfiltered = contentQbankQuestionsQuery({ examTrack: 'mccqe' });
  assert.deepEqual(unfiltered.values.at(-1), []);
});
