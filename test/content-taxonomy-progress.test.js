import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Exercise the actual server helper without starting services or paid calls.
const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = server.indexOf('function ngContentTaxonomyProgress(');
const end = server.indexOf('\nfunction ngContentTaxonomyTransientClassifierError', start);
assert.ok(start >= 0 && end > start, 'Locate the actual taxonomy progress helper');
const progress = vm.runInNewContext(`${server.slice(start, end)}; ngContentTaxonomyProgress;`, {
  ngRecordDailyLiveSessionPhaseState() { throw new Error('Taxonomy progress must not mutate live-session state'); },
});
const plain = value => JSON.parse(JSON.stringify(value));

test('a taxonomy job can initialize and advance progress without live-session state', () => {
  const initial = progress({}, { total: 3, stage: 'reading_pair_evidence' });
  assert.deepEqual(plain(initial), {
    total: 3, stage: 'reading_pair_evidence', next_index: 0, processed: 0,
    pending: 3, approved: 0, needs_review: 0, failed: 0, skipped: 0, percent: 0, errors: [],
  });
  const advanced = progress(initial, { next_index: 1, needs_review: 1, stage: 'pair_settled' });
  assert.equal(advanced.processed, 1);
  assert.equal(advanced.pending, 2);
  assert.equal(advanced.needs_review, 1);
  assert.equal(advanced.percent, 33);
  assert.equal(initial.next_index, 0, 'The saved input snapshot stays unchanged');
});

test('recovered taxonomy progress reconciles duplicate counters and preserves bounded errors', () => {
  const errors = Array.from({ length: 125 }, (_, index) => ({ pair_key: String(index), error: 'Review needed' }));
  const job = { total: 5, next_index: 3, approved: 1, needs_review: 5, failed: 1, skipped: 1, errors };
  const recovered = progress(job);
  assert.equal(recovered.approved + recovered.needs_review + recovered.failed + recovered.skipped, 3);
  assert.equal(recovered.approved, 1);
  assert.equal(recovered.processed, 3);
  assert.equal(recovered.pending, 2);
  assert.equal(recovered.errors.length, 100);
  assert.equal(recovered.errors[0].pair_key, '25');
  assert.equal(job.needs_review, 5);
  assert.equal(errors.length, 125);
  const complete = progress(recovered, { next_index: 100, needs_review: 2 });
  assert.equal(complete.next_index, 5);
  assert.equal(complete.pending, 0);
  assert.equal(complete.percent, 100);
});
